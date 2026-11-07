/*
 * Copyright (c) 2019 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include <stdio.h>
#include <errno.h>
#include <string.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/mesh.h>
#include <bluetooth/mesh/models.h>

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/shell/shell_uart.h>

#include "audio_player.h"
#include "audio_player_diag.h"
#include <zephyr/fs/fs.h>

#include "chat_cli.h"
#include "model_handler.h"
#include "sd_card.h"
#include "web_api.h"

#include <zephyr/logging/log.h>

#include <stdlib.h>

LOG_MODULE_DECLARE(chat);

static const struct shell *chat_shell;

/* Diagnostics remain opt-in: no Heartbeats are sent on boot. */
#define MESH_DIAG_HEARTBEAT_GROUP 0xC001
#define MESH_DIAG_HB_SUB_PERIOD_LOG 17 /* 2^16 seconds (~18 hours) */
#define MESH_DIAG_HB_TTL 7

static struct {
    uint32_t rx_count;
    int64_t last_rx_ms;
    uint8_t last_hops;
    uint16_t features;
} heartbeat_diag;

static void heartbeat_received(const struct bt_mesh_hb_sub *sub,
                               uint8_t hops, uint16_t feat)
{
    ARG_UNUSED(sub);
    heartbeat_diag.rx_count++;
    heartbeat_diag.last_rx_ms = k_uptime_get();
    heartbeat_diag.last_hops = hops;
    heartbeat_diag.features = feat;
}

BT_MESH_HB_CB_DEFINE(meshyq_heartbeat_callbacks) = {
    .recv = heartbeat_received,
};

/* Only one controller-side outstanding diagnostic probe at a time. */
static struct {
    uint32_t id;
    uint16_t addr;
    int64_t sent_ms;
    bool pending;
} diag_pending;

static uint32_t next_diag_id = 1;


/******************************************************************************/
/*************************** Health server setup ******************************/
/******************************************************************************/
static struct bt_mesh_health_srv health_srv;

BT_MESH_HEALTH_PUB_DEFINE(health_pub, 0);

/******************************************************************************/
/***************************** Chat model setup *******************************/
/******************************************************************************/
struct presence_cache {
	uint16_t addr;
	enum bt_mesh_chat_cli_presence presence;
};

/* Cache of Presence values of other chat clients. */
static struct presence_cache presence_cache[
			    CONFIG_BT_MESH_CHAT_SAMPLE_PRESENCE_CACHE_SIZE];

static const uint8_t *presence_string[] = {
	[BT_MESH_CHAT_CLI_PRESENCE_AVAILABLE] = "available",
	[BT_MESH_CHAT_CLI_PRESENCE_AWAY] = "away",
	[BT_MESH_CHAT_CLI_PRESENCE_DO_NOT_DISTURB] = "dnd",
	[BT_MESH_CHAT_CLI_PRESENCE_INACTIVE] = "inactive",
};

const char *model_handler_presence_to_string(enum bt_mesh_chat_cli_presence presence)
{
	return (const char *)presence_string[presence];
}

bool model_handler_presence_from_string(const char *str, enum bt_mesh_chat_cli_presence *presence)
{
	size_t i;

	for (i = 0; i < ARRAY_SIZE(presence_string); i++) {
		if (!strcmp(str, (const char *)presence_string[i])) {
			*presence = (enum bt_mesh_chat_cli_presence)i;
			return true;
		}
	}

	return false;
}

/**
 * Returns true if the specified address is an address of the local element.
 */
static bool address_is_local(const struct bt_mesh_model *mod, uint16_t addr)
{
	return bt_mesh_model_elem(mod)->rt->addr == addr;
}

/**
 * Returns true if the provided address is unicast address.
 */
static bool address_is_unicast(uint16_t addr)
{
	return (addr > 0) && (addr <= 0x7FFF);
}

/**
 * Returns true if the node is new or the presence status is different from
 * the one stored in the cache.
 */
static bool presence_cache_entry_check_and_update(uint16_t addr,
				       enum bt_mesh_chat_cli_presence presence)
{
	static size_t presence_cache_head;
	size_t i;

	/* Find address in cache. */
	for (i = 0; i < ARRAY_SIZE(presence_cache); i++) {
		if (presence_cache[i].addr == addr) {
			if (presence_cache[i].presence == presence) {
				return false;
			}

			/* Break since the node in the cache. */
			break;
		}
	}

	/* Not in cache. */
	if (i == ARRAY_SIZE(presence_cache)) {
		for (i = 0; i < ARRAY_SIZE(presence_cache); i++) {
			if (!presence_cache[i].addr) {
				break;
			}
		}

		/* Cache is full. */
		if (i == ARRAY_SIZE(presence_cache)) {
			i = presence_cache_head;
			presence_cache_head = (presence_cache_head + 1)
			% CONFIG_BT_MESH_CHAT_SAMPLE_PRESENCE_CACHE_SIZE;
		}
	}

	/* Update cache. */
	presence_cache[i].addr = addr;
	presence_cache[i].presence = presence;

	return true;
}

static void print_client_status(void);

static void handle_chat_start(struct bt_mesh_chat_cli *chat)
{
	print_client_status();
}

/* Deferred worker for "list": sd_card_list_playable_files() does a full
 * FAT directory scan over SPI, which is too slow to run directly on the
 * Bluetooth Mesh model's incoming-message dispatch path -- while it's
 * running, this node can't process other concurrently-arriving segmented
 * messages (see the mesh RX segment slot exhaustion this caused). Mirrors
 * audio_player.c's own thread-plus-semaphore pattern for the same class
 * of problem, with its own stack for the same reason: FatFs keeps
 * per-call work buffers on the stack.
 */
#define LIST_WORKER_STACK_SIZE 4096
/* One priority step below audio_player.c's AUDIO_THREAD_PRIO (7), so a
 * list scan can never delay audio buffer feeding.
 */
#define LIST_WORKER_THREAD_PRIO 8

K_THREAD_STACK_DEFINE(list_worker_stack, LIST_WORKER_STACK_SIZE);

static struct {
	struct k_sem request;
	struct k_mutex lock;
	struct k_thread thread;
	k_tid_t thread_id;
	bool busy;
	struct bt_mesh_chat_cli *pending_chat;
	struct bt_mesh_msg_ctx pending_ctx;
	    int action; /* 0=list, 1=discover, 2=audio check */
    char filename[32];
	
} list_worker;


static void list_worker_thread(void *arg1, void *arg2, void *arg3)
{
    ARG_UNUSED(arg1);
    ARG_UNUSED(arg2);
    ARG_UNUSED(arg3);

    while (1) {
        struct bt_mesh_chat_cli *chat;
        struct bt_mesh_msg_ctx ctx;
        char files[BT_MESH_CHAT_CLI_MSG_MAXLEN_MESSAGE];
        int count;
        int action;
        char requested_file[32];

        k_sem_take(&list_worker.request, K_FOREVER);

        k_mutex_lock(&list_worker.lock, K_FOREVER);
        chat = list_worker.pending_chat;
        ctx = list_worker.pending_ctx;
        action = list_worker.action;
        memcpy(requested_file, list_worker.filename,
               sizeof(requested_file));
        k_mutex_unlock(&list_worker.lock);

        if (action == 1) {
            /* Discover the letter from node.cfg */
            char path[128];
            char buf[64] = {0};
            struct fs_file_t file;
            bool valid = false;
            char letter = '?';

            if (sd_card_resolve_root_file(
                    "node.cfg", path, sizeof(path))) {

                fs_file_t_init(&file);

                if (fs_open(&file, path, FS_O_READ) == 0) {
                    ssize_t n = fs_read(
                        &file, buf, sizeof(buf) - 1);

                    (void)fs_close(&file);

                    if (n > 0) {
                        buf[n] = '\0';

                        char *line = strstr(buf, "letter=");

                        if (line &&
                            (line == buf || line[-1] == '\n')) {

                            char x = line[7];

                            if (x >= 'A' && x <= 'Z' &&
                                (line[8] == '\n' ||
                                 line[8] == '\r' ||
                                 line[8] == '\0' ||
                                 line[8] == ' ')) {
                                letter = x;
                                valid = true;
                            }
                        }
                    }
                }
            }

            snprintf(files, sizeof(files),
                     "diag_id letter=%c valid=%u",
                     letter, valid ? 1U : 0U);

            (void)bt_mesh_chat_cli_reply_send(
                chat, &ctx, (const uint8_t *)files);

        } else if (action == 2) {
            /* Check WAV or MP3 without playing it */
            char path[128];

            bool ready = audio_player_is_ready();

            bool exists = ready &&
                sd_card_resolve_root_file(
                    requested_file, path, sizeof(path));

            snprintf(files, sizeof(files),
                     "diag_audio ready=%u file_ok=%u file=%s",
                     ready ? 1U : 0U,
                     exists ? 1U : 0U,
                     requested_file);

            (void)bt_mesh_chat_cli_reply_send(
                chat, &ctx, (const uint8_t *)files);

        } else {
            /* Existing SD card listing */
            count = sd_card_list_playable_files(
                files, sizeof(files));

            (void)bt_mesh_chat_cli_reply_send(
                chat, &ctx,
                count > 0 ? (const uint8_t *)files
                          : (const uint8_t *)"(none)");
        }

        k_mutex_lock(&list_worker.lock, K_FOREVER);
        list_worker.busy = false;
        k_mutex_unlock(&list_worker.lock);
    }
}


static int list_worker_request(struct bt_mesh_chat_cli *chat, struct bt_mesh_msg_ctx *ctx)
{
	k_mutex_lock(&list_worker.lock, K_FOREVER);
	if (list_worker.busy) {
		k_mutex_unlock(&list_worker.lock);
		return -EALREADY;
	}

	list_worker.busy = true;
	list_worker.pending_chat = chat;
	list_worker.pending_ctx = *ctx;

	list_worker.action = 0;
	list_worker.filename[0] = '\0';

	k_mutex_unlock(&list_worker.lock);

	k_sem_give(&list_worker.request);
	return 0;
}


static int diagnostic_worker_request(
    struct bt_mesh_chat_cli *chat,
    struct bt_mesh_msg_ctx *ctx,
    int action,
    const char *filename)
{
    k_mutex_lock(&list_worker.lock, K_FOREVER);

    if (list_worker.busy) {
        k_mutex_unlock(&list_worker.lock);
        return -EBUSY;
    }

    list_worker.busy = true;
    list_worker.pending_chat = chat;
    list_worker.pending_ctx = *ctx;
    list_worker.action = action;

    snprintf(list_worker.filename,
             sizeof(list_worker.filename),
             "%s", filename ? filename : "");

    k_mutex_unlock(&list_worker.lock);

    k_sem_give(&list_worker.request);
    return 0;
}

static void list_worker_init(void)
{
	k_sem_init(&list_worker.request, 0, 1);
	k_mutex_init(&list_worker.lock);

	list_worker.thread_id = k_thread_create(&list_worker.thread, list_worker_stack,
						K_THREAD_STACK_SIZEOF(list_worker_stack),
						list_worker_thread, NULL, NULL, NULL,
						K_PRIO_PREEMPT(LIST_WORKER_THREAD_PRIO), 0,
						K_NO_WAIT);
	(void)k_thread_name_set(list_worker.thread_id, "list_worker");
}

/**
 * Mesh messages use a formal "cmd args" grammar, e.g. "play a.wav". This
 * keeps free-form chat text (which never matches a known verb) inert, same
 * as before, while giving each action its own explicit command instead of
 * treating every message as a filename to try to play.
 */
static void cmd_play(const char *args)
{
	int err;

	err = audio_player_play_file(args);
	if (err && err != -ENOENT) {
		LOG_WRN("Failed to play %s: %d", args, err);
	}
}

/**
 * "find <file>" checks whether this node has the file, without playing it.
 * Only a node that has the file replies, so the sender can tell who has it
 * purely from which nodes ack -- this is also the tool for confirming the
 * mesh is actually delivering messages end-to-end across the whole fleet.
 */
static void cmd_find(struct bt_mesh_chat_cli *chat, struct bt_mesh_msg_ctx *ctx,
		     const char *args)
{
	char path[128];
	char reply[64];

	if (sd_card_resolve_root_file(args, path, sizeof(path))) {
		snprintf(reply, sizeof(reply), "found %s", args);
		(void)bt_mesh_chat_cli_reply_send(chat, ctx, (const uint8_t *)reply);
	}
}

/**
 * "list" asks every node to announce its playable files, comma-separated,
 * in one reply -- unlike "find", every node replies (even with "(none)"),
 * since the point is a full roll call rather than locating one file.
 */
static void cmd_list(struct bt_mesh_chat_cli *chat, struct bt_mesh_msg_ctx *ctx)
{
	int err;

	err = list_worker_request(chat, ctx);
	if (err) {
		LOG_WRN("Failed to queue list request: %d", err);
	}
}


/* * "volume_get" asks every node to announce its volume, provides list */

static void cmd_volume_get(struct bt_mesh_chat_cli *chat, struct bt_mesh_msg_ctx *ctx)
{
    char reply[64];

    snprintf(reply, sizeof(reply), "Volume: %u%%", audio_player_get_volume());

    (void)bt_mesh_chat_cli_reply_send(chat, ctx, (const uint8_t *)reply);
}

/* "volume_set" sets volume of every node in mesh network 
	... eventually need to implement feature that supports setting volume of specific nodes*/
 
static void cmd_volume_set(struct bt_mesh_chat_cli *chat, struct bt_mesh_msg_ctx *ctx, const char *args)
{
	char reply[64];
    char *endptr;
    long percent;
    int err;

    percent = strtol(args, &endptr, 10);

    if (args == endptr || *endptr != '\0' ||
        percent < 0 || percent > 100) {
        snprintf(reply, sizeof(reply), "Invalid volume percentage");
    } else {
        err = audio_player_set_volume((uint8_t)percent);

        if (err == 0) {
            snprintf(reply, sizeof(reply), "Volume set to %u%%",
                     audio_player_get_volume());
        } else {
            snprintf(reply, sizeof(reply),
                     "Failed to set volume: %d", err);
        }
    }

   /* (void)bt_mesh_chat_cli_reply_send(chat, ctx,
                                      (const uint8_t *)reply);*/
}


/** @brief Answer an addressed diagnostic probe without accessing the SD card. */
static void cmd_diag_probe(struct bt_mesh_chat_cli *chat,
                           struct bt_mesh_msg_ctx *ctx, const char *args)
{
    unsigned long id;
    char extra;
    char *end;
    char reply[96];

    if (!address_is_unicast(ctx->recv_dst)) {
        return; /* Do not broadcast replies to all nodes. */
    }

    id = strtoul(args, &end, 10);
    if (args == end || *end != '\0' || id == 0 ||
        id > UINT32_MAX || sscanf(args, "%lu %c", &id, &extra) != 1) {
        return;
    }

    snprintf(reply, sizeof(reply), "diag_probe %lu ttl=%u rssi=%d",
             id, (unsigned int)ctx->recv_ttl, (int)ctx->recv_rssi);
    (void)bt_mesh_chat_cli_reply_send(chat, ctx, (const uint8_t *)reply);
}

/** @brief Return local Heartbeat statistics to the requesting controller. */
static void cmd_diag_hb_get(struct bt_mesh_chat_cli *chat,
                            struct bt_mesh_msg_ctx *ctx)
{
    struct bt_mesh_hb_sub sub = {0};
    char reply[150];

    if (!address_is_unicast(ctx->recv_dst)) {
        return;
    }

    bt_mesh_hb_sub_get(&sub);
    snprintf(reply, sizeof(reply),
             "diag_hb count=%u min=%u max=%u last=%u age_ms=%lld",
             (unsigned int)sub.count,
             (unsigned int)sub.min_hops,
             (unsigned int)sub.max_hops,
             (unsigned int)heartbeat_diag.last_hops,
             (long long)(heartbeat_diag.rx_count ?
                 k_uptime_get() - heartbeat_diag.last_rx_ms : -1LL));
    (void)bt_mesh_chat_cli_reply_send(chat, ctx, (const uint8_t *)reply);
}


static void cmd_diag_discover(
    struct bt_mesh_chat_cli *chat,
    struct bt_mesh_msg_ctx *ctx)
{
    (void)diagnostic_worker_request(
        chat, ctx, 1, NULL);
}

static void cmd_diag_audio(
    struct bt_mesh_chat_cli *chat,
    struct bt_mesh_msg_ctx *ctx,
    const char *filename)
{
    if (!address_is_unicast(ctx->recv_dst)) {
        return;
    }

    size_t len = strlen(filename);

    if (len < 5 || len >= 31 ||
        strpbrk(filename, "/\\ \t\r\n")) {
        return;
    }

    /* Accept both WAV and MP3 */
    if (strcmp(filename + len - 4, ".WAV") &&
        strcmp(filename + len - 4, ".wav") &&
        strcmp(filename + len - 4, ".MP3") &&
        strcmp(filename + len - 4, ".mp3")) {
        return;
    }

    (void)diagnostic_worker_request(
        chat, ctx, 2, filename);
}

static void handle_command(struct bt_mesh_chat_cli *chat, struct bt_mesh_msg_ctx *ctx,
			   const uint8_t *msg)
{
	const char *text = (const char *)msg;
	const char *space = strchr(text, ' ');
	size_t cmd_len = space ? (size_t)(space - text) : strlen(text);
	const char *args = space ? space + 1 : "";

	if (cmd_len == strlen("play") && strncmp(text, "play", cmd_len) == 0) {
		cmd_play(args);
	} else if (cmd_len == strlen("find") && strncmp(text, "find", cmd_len) == 0) {
		cmd_find(chat, ctx, args);
	} else if (cmd_len == strlen("list") && strncmp(text, "list", cmd_len) == 0) {
		cmd_list(chat, ctx);
	} else if (cmd_len == strlen("diag_discover") && strncmp(text, "diag_discover", cmd_len) == 0) {
		cmd_diag_discover(chat, ctx);
	} else if (cmd_len == strlen("diag_audio") && strncmp(text, "diag_audio", cmd_len) == 0) {
		cmd_diag_audio(chat, ctx, args);
    } else if (cmd_len == strlen("diag_probe") && strncmp(text, "diag_probe", cmd_len) == 0) {
        cmd_diag_probe(chat, ctx, args);
    } else if (cmd_len == strlen("diag_hb_get") && strncmp(text, "diag_hb_get", cmd_len) == 0) {
        cmd_diag_hb_get(chat, ctx);
	} else if (cmd_len == strlen("volume_get") && strncmp(text, "volume_get", cmd_len) == 0) {
    	cmd_volume_get(chat, ctx);
    } else if (cmd_len == strlen("volume_set") && strncmp(text, "volume_set", cmd_len) == 0) {
        cmd_volume_set(chat, ctx, args);
    }
	/* Unrecognized verb (or plain chat text): no action, same as before. */
}

static void handle_chat_presence(struct bt_mesh_chat_cli *chat,
				 struct bt_mesh_msg_ctx *ctx,
				 enum bt_mesh_chat_cli_presence presence)
{
	if (address_is_local(chat->model, ctx->addr)) {
		if (address_is_unicast(ctx->recv_dst)) {
			shell_print(chat_shell, "<you> are %s",
				    presence_string[presence]);
		}
	} else {
		if (address_is_unicast(ctx->recv_dst)) {
			shell_print(chat_shell, "<0x%04X> is %s", ctx->addr,
				    presence_string[presence]);
			web_api_notify_presence(ctx->addr, presence);
		} else if (presence_cache_entry_check_and_update(ctx->addr,
								 presence)) {
			shell_print(chat_shell, "<0x%04X> is now %s",
				    ctx->addr,
				    presence_string[presence]);
			web_api_notify_presence(ctx->addr, presence);
		}
	}
}

static void handle_chat_message(struct bt_mesh_chat_cli *chat,
				struct bt_mesh_msg_ctx *ctx,
				const uint8_t *msg)
{
	/* Don't react to our own messages. */
	if (address_is_local(chat->model, ctx->addr)) {
		return;
	}

    if (strncmp((const char *)msg, "play ", 5) == 0) {
        LOG_INF("DIAG MESH_RX t=%lld src=0x%04x ttl=%u rssi=%d file=%s",
                (long long)k_uptime_get(), ctx->addr,
                (unsigned int)ctx->recv_ttl, (int)ctx->recv_rssi,
                (const char *)msg + 5);
    }
	shell_print(chat_shell, "<0x%04X>: %s", ctx->addr, msg);
	web_api_notify_chat_message(ctx->addr, (const char *)msg);
	handle_command(chat, ctx, msg);
}

static void handle_chat_private_message(struct bt_mesh_chat_cli *chat,
					struct bt_mesh_msg_ctx *ctx,
					const uint8_t *msg)
{
	/* Don't react to our own messages. */
	if (address_is_local(chat->model, ctx->addr)) {
		return;
	}

    if (strncmp((const char *)msg, "play ", 5) == 0) {
        LOG_INF("DIAG MESH_RX t=%lld src=0x%04x ttl=%u rssi=%d file=%s",
                (long long)k_uptime_get(), ctx->addr,
                (unsigned int)ctx->recv_ttl, (int)ctx->recv_rssi,
                (const char *)msg + 5);
    }
	shell_print(chat_shell, "<0x%04X>: *you* %s", ctx->addr, msg);
	web_api_notify_chat_private_message(ctx->addr, (const char *)msg);
	handle_command(chat, ctx, msg);
}


static void handle_chat_message_reply(struct bt_mesh_chat_cli *chat,
                                      struct bt_mesh_msg_ctx *ctx,
                                      const uint8_t *msg)
{
    unsigned long id;
    unsigned int ttl;
    int rssi;

    if (sscanf((const char *)msg, "diag_probe %lu ttl=%u rssi=%d",
               &id, &ttl, &rssi) == 3 && diag_pending.pending &&
        id == diag_pending.id && ctx->addr == diag_pending.addr) {

        int64_t rtt_ms = k_uptime_get() - diag_pending.sent_ms;
        diag_pending.pending = false;

        /* Print diagnostic result to debug terminal */
        shell_print(chat_shell,
                    "DIAG RESULT node=0x%04x id=%lu rtt_ms=%lld rx_ttl=%u rx_rssi=%d",
                    ctx->addr, id, (long long)rtt_ms, ttl, rssi);

        /* Send diagnostic result to the web interface */
        char result[128];

        snprintf(result, sizeof(result),
                 "diag_result id=%lu rtt_ms=%lld ttl=%u rssi=%d",
                 id, (long long)rtt_ms, ttl, rssi);

        web_api_notify_chat_message_reply(ctx->addr, result);
    }

    /* Existing message handling — keep this */
    shell_print(chat_shell, "<0x%04X>: %s", ctx->addr, msg);
    web_api_notify_chat_message_reply(ctx->addr, (const char *)msg);
}


static const struct bt_mesh_chat_cli_handlers chat_handlers = {
	.start = handle_chat_start,
	.presence = handle_chat_presence,
	.message = handle_chat_message,
	.private_message = handle_chat_private_message,
	.message_reply = handle_chat_message_reply,
};

/* .. include_startingpoint_model_handler_rst_1 */
static struct bt_mesh_chat_cli chat = {
	.handlers = &chat_handlers,
};

static struct bt_mesh_cfg_cli cfg_cli = {};

static struct bt_mesh_elem elements[] = {
	BT_MESH_ELEM(
		1,
		BT_MESH_MODEL_LIST(
			BT_MESH_MODEL_CFG_SRV,
			BT_MESH_MODEL_CFG_CLI(&cfg_cli),
			BT_MESH_MODEL_HEALTH_SRV(&health_srv, &health_pub)),
		BT_MESH_MODEL_LIST(BT_MESH_MODEL_CHAT_CLI(&chat))),
};
/* .. include_endpoint_model_handler_rst_1 */

void model_handler_status(bool *provisioned, uint16_t *addr,
			  enum bt_mesh_chat_cli_presence *presence)
{
	*provisioned = bt_mesh_is_provisioned();
	*addr = *provisioned ? bt_mesh_model_elem(chat.model)->rt->addr : 0;
	*presence = chat.presence;
}

static void print_client_status(void)
{
	bool provisioned;
	uint16_t addr;
	enum bt_mesh_chat_cli_presence presence;

	model_handler_status(&provisioned, &addr, &presence);

	if (!provisioned) {
		shell_print(chat_shell,
			    "The mesh node is not provisioned. Please provision the mesh node before using the chat.");
	} else {
		shell_print(chat_shell,
			    "The mesh node is provisioned. The client address is 0x%04x.",
			    addr);
	}

	shell_print(chat_shell, "Current presence: %s",
		    presence_string[presence]);
}

static const struct bt_mesh_comp comp = {
	.cid = CONFIG_BT_COMPANY_ID,
	.elem = elements,
	.elem_count = ARRAY_SIZE(elements),
};

/******************************************************************************/
/******************************** Chat shell **********************************/
/******************************************************************************/
static int cmd_status(const struct shell *shell, size_t argc, char *argv[])
{
	print_client_status();

	return 0;
}

int model_handler_chat_send(const char *msg)
{
	return bt_mesh_chat_cli_message_send(&chat, (const uint8_t *)msg);
}

int model_handler_chat_send_private(uint16_t addr, const char *msg)
{
	return bt_mesh_chat_cli_private_message_send(&chat, addr, (const uint8_t *)msg);
}

int model_handler_presence_set(enum bt_mesh_chat_cli_presence presence)
{
	return bt_mesh_chat_cli_presence_set(&chat, presence);
}

int model_handler_presence_get(uint16_t addr)
{
	return bt_mesh_chat_cli_presence_get(&chat, addr);
}


int model_handler_diag_discover(void)
{
    return model_handler_chat_send("diag_discover");
}

int model_handler_diag_audio_check(
    uint16_t addr, const char *filename)
{
    char message[64];
    size_t len;

    if (!address_is_unicast(addr) || !filename) {
        return -EINVAL;
    }

    len = strlen(filename);

    if (len < 5 || len > 30 ||
        strpbrk(filename, "/\\ \t\r\n")) {
        return -EINVAL;
    }

    if (strcmp(filename + len - 4, ".WAV") &&
        strcmp(filename + len - 4, ".wav") &&
        strcmp(filename + len - 4, ".MP3") &&
        strcmp(filename + len - 4, ".mp3")) {
        return -EINVAL;
    }

    snprintf(message, sizeof(message),
             "diag_audio %s", filename);

    return model_handler_chat_send_private(
        addr, message);
}


int model_handler_diag_probe(uint16_t addr, uint32_t probe_id)
{
    char message[48];
    int err;

    if (!address_is_unicast(addr) || probe_id == 0) return -EINVAL;
    if (diag_pending.pending && k_uptime_get() - diag_pending.sent_ms < 5000) {
        return -EBUSY;
    }

    snprintf(message, sizeof(message), "diag_probe %u", (unsigned int)probe_id);
    diag_pending.id = probe_id;
    diag_pending.addr = addr;
    diag_pending.sent_ms = k_uptime_get();
    diag_pending.pending = true;
    err = model_handler_chat_send_private(addr, message);
    if (err) diag_pending.pending = false;
    return err;
}

int model_handler_diag_hb_get(uint16_t addr)
{
    if (!address_is_unicast(addr)) return -EINVAL;
    return model_handler_chat_send_private(addr, "diag_hb_get");
}

/* Config Server and Client are already present on every MeshyQ node.
 * Use the local Configuration Client to configure this node's own server.
 */
int model_handler_diag_hb_publish(uint8_t period_log)
{
    struct bt_mesh_cfg_cli_hb_pub pub = {
        .dst = period_log ? MESH_DIAG_HEARTBEAT_GROUP : 0,
        .count = period_log ? 0xff : 0,
        .period = period_log,
        .ttl = MESH_DIAG_HB_TTL,
        .feat = 0,
        .net_idx = 0,
    };

    if (period_log > 17) return -EINVAL;
    if (!bt_mesh_is_provisioned()) return -ENODEV;
    return bt_mesh_cfg_cli_hb_pub_set(0, model_handler_addr(), &pub, NULL);
}

int model_handler_diag_hb_subscribe(uint16_t source_addr)
{
    struct bt_mesh_cfg_cli_hb_sub sub = {
        .src = source_addr,
        .dst = source_addr ? MESH_DIAG_HEARTBEAT_GROUP : 0,
        .period = source_addr ? MESH_DIAG_HB_SUB_PERIOD_LOG : 0,
    };

    if (source_addr != 0 && !address_is_unicast(source_addr)) return -EINVAL;
    if (!bt_mesh_is_provisioned()) return -ENODEV;
    heartbeat_diag.rx_count = 0;
    heartbeat_diag.last_rx_ms = 0;
    return bt_mesh_cfg_cli_hb_sub_set(0, model_handler_addr(), &sub, NULL);
}

static int cmd_message(const struct shell *shell, size_t argc, char *argv[])
{
	int err;

	if (argc < 2) {
		return -EINVAL;
	}

	err = model_handler_chat_send(argv[1]);
	if (err) {
		LOG_WRN("Failed to send message: %d", err);
	}

	/* Print own messages in the chat. */
	shell_print(shell, "<you>: %s", argv[1]);

	return 0;
}

static int cmd_private_message(const struct shell *shell, size_t argc,
			       char *argv[])
{
	uint16_t addr;
	int err;

	if (argc < 3) {
		return -EINVAL;
	}

	addr = strtol(argv[1], NULL, 0);

	/* Print own message to the chat. */
	shell_print(shell, "<you>: *0x%04X* %s", addr, argv[2]);

	err = model_handler_chat_send_private(addr, argv[2]);
	if (err) {
		LOG_WRN("Failed to publish message: %d", err);
	}

	return 0;
}

static int cmd_presence_set(const struct shell *shell, size_t argc,
			    char *argv[])
{
	enum bt_mesh_chat_cli_presence presence;
	size_t i;
	int err;

	if (argc < 2) {
		return -EINVAL;
	}

	if (!model_handler_presence_from_string(argv[1], &presence)) {
		shell_print(shell,
			    "Unknown presence status: %s. Possible presence statuses:",
			    argv[1]);
		for (i = 0; i < ARRAY_SIZE(presence_string); i++) {
			shell_print(shell, "%s", presence_string[i]);
		}

		return 0;
	}

	err = model_handler_presence_set(presence);
	if (err) {
		LOG_WRN("Failed to update presence: %d", err);
	}

	/* Print own presence in the chat. */
	shell_print(shell, "You are now %s", presence_string[presence]);

	return 0;
}

static int cmd_presence_get(const struct shell *shell, size_t argc,
			    char *argv[])
{
	uint16_t addr;
	int err;

	if (argc < 2) {
		return -EINVAL;
	}

	addr = strtol(argv[1], NULL, 0);

	err = model_handler_presence_get(addr);
	if (err) {
		LOG_WRN("Failed to publish message: %d", err);
	}

	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(presence_cmds,
	SHELL_CMD_ARG(set, NULL,
		      "Set presence of the current client <presence: available, away, dnd or inactive>",
		      cmd_presence_set, 2, 0),
	SHELL_CMD_ARG(get, NULL,
		      "Get presence status of the remote node <node>",
		      cmd_presence_get, 2, 0),
	SHELL_SUBCMD_SET_END
);

static int cmd_presence(const struct shell *shell, size_t argc, char *argv[])
{
	if (argc == 1) {
		shell_help(shell);
		/* shell returns 1 when help is printed */
		return 1;
	}

	if (argc != 3) {
		return -EINVAL;
	}

	return 0;
}

static int diag_shell_probe(const struct shell *shell, size_t argc, char *argv[])
{
    char *end;
    unsigned long addr = strtoul(argv[1], &end, 0);
    uint32_t id = next_diag_id++;
    int err;

    if (*end || !address_is_unicast((uint16_t)addr) || addr > 0x7fff) return -EINVAL;
    if (argc >= 3) {
        unsigned long parsed = strtoul(argv[2], &end, 0);
        if (*end || parsed == 0 || parsed > UINT32_MAX) return -EINVAL;
        id = (uint32_t)parsed;
    }
    err = model_handler_diag_probe((uint16_t)addr, id);
    shell_print(shell, "Probe -> 0x%04lx id=%u result=%d", addr, id, err);
    return err;
}

static int diag_shell_hb_get(const struct shell *shell, size_t argc, char *argv[])
{
    char *end;
    unsigned long addr = strtoul(argv[1], &end, 0);
    if (*end || addr == 0 || addr > 0x7fff) return -EINVAL;
    return model_handler_diag_hb_get((uint16_t)addr);
}

static int diag_shell_hb_pub(const struct shell *shell, size_t argc, char *argv[])
{
    char *end;
    unsigned long period = strtoul(argv[1], &end, 0);
    if (*end || period > 17) return -EINVAL;
    int err = model_handler_diag_hb_publish((uint8_t)period);
    shell_print(shell, "Heartbeat publication requested: period log=%lu, err=%d",
                period, err);
    return err;
}

static int diag_shell_hb_sub(const struct shell *shell, size_t argc, char *argv[])
{
    char *end;
    unsigned long addr = strtoul(argv[1], &end, 0);
    if (*end || addr > 0x7fff) return -EINVAL;
    int err = model_handler_diag_hb_subscribe((uint16_t)addr);
    shell_print(shell, "Heartbeat subscription requested: src=0x%04lx, err=%d",
                addr, err);
    return err;
}

static int diag_shell_hb_status(const struct shell *shell, size_t argc, char *argv[])
{
    struct bt_mesh_hb_sub sub = {0};
    struct bt_mesh_hb_pub pub = {0};
    bt_mesh_hb_sub_get(&sub);
    bt_mesh_hb_pub_get(&pub);
    shell_print(shell,
                "HB SUB src=0x%04x dst=0x%04x count=%u min=%u max=%u remaining_s=%u last_hops=%u age_ms=%lld",
                sub.src, sub.dst, (unsigned int)sub.count,
                (unsigned int)sub.min_hops, (unsigned int)sub.max_hops,
                (unsigned int)sub.remaining,
                (unsigned int)heartbeat_diag.last_hops,
                (long long)(heartbeat_diag.rx_count ?
                    k_uptime_get() - heartbeat_diag.last_rx_ms : -1LL));
    shell_print(shell, "HB PUB dst=0x%04x period_s=%u count=%u",
                pub.dst, (unsigned int)pub.period, (unsigned int)pub.count);
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(diag_cmds,
    SHELL_CMD_ARG(probe, NULL, "Probe a node: <addr> [probe-id]", diag_shell_probe, 2, 1),
    SHELL_CMD_ARG(hb_get, NULL, "Request node heartbeat summary: <addr>", diag_shell_hb_get, 2, 0),
    SHELL_CMD_ARG(hb_pub, NULL, "Publish control heartbeat, log period 0=off, 5=16 sec", diag_shell_hb_pub, 2, 0),
    SHELL_CMD_ARG(hb_sub, NULL, "Subscribe locally to controller <addr>; 0=off", diag_shell_hb_sub, 2, 0),
    SHELL_CMD_ARG(hb_status, NULL, "Show local Heartbeat statistics", diag_shell_hb_status, 1, 0),
    SHELL_SUBCMD_SET_END
);

SHELL_CMD_REGISTER(diag, &diag_cmds, "MeshyQ diagnostics (firmware)", NULL);

SHELL_STATIC_SUBCMD_SET_CREATE(chat_cmds,
	SHELL_CMD_ARG(status, NULL, "Print client status", cmd_status, 1, 0),
	SHELL_CMD(presence, &presence_cmds, "Presence commands", cmd_presence),
	/* SHELL_OPT_ARG_RAW: <cmd> <args> is a multi-word command (e.g.
	 * "play a.wav"), so everything after <node>/the subcommand name must
	 * be passed through as one raw, unsplit string instead of being
	 * tokenized on whitespace.
	 */
	SHELL_CMD_ARG(private, NULL,
		      "Send a command as a private message to a client <node> <cmd> <args>",
		      cmd_private_message, 2, SHELL_OPT_ARG_RAW),
	SHELL_CMD_ARG(msg, NULL, "Send a command to the chat <cmd> <args>",
		      cmd_message, 1, SHELL_OPT_ARG_RAW),
	SHELL_SUBCMD_SET_END
);

static int cmd_chat(const struct shell *shell, size_t argc, char **argv)
{
	if (argc == 1) {
		shell_help(shell);
		/* shell returns 1 when help is printed */
		return 1;
	}

	shell_error(shell, "%s unknown parameter: %s", argv[0], argv[1]);

	return -EINVAL;
}

SHELL_CMD_ARG_REGISTER(chat, &chat_cmds, "Bluetooth Mesh Chat Client commands",
		       cmd_chat, 1, 1);

/******************************************************************************/
/******************************** Cue shell ************************************/
/******************************************************************************/
/*
 * Thin, discoverable wrappers around the "cmd args" mesh grammar: `cue play
 * <file>` / `cue find <file>` are shorthand for `chat msg play <file>` /
 * `chat msg find <file>` (always a group broadcast). `chat msg`/`chat
 * private` remain available for free-form messages or for targeting one
 * node directly.
 */
static int cue_build_and_send(const char *cmd, const char *args, char *msg_out,
			      size_t msg_out_size)
{
	if (args[0] != '\0') {
		snprintf(msg_out, msg_out_size, "%s %s", cmd, args);
	} else {
		snprintf(msg_out, msg_out_size, "%s", cmd);
	}

	return model_handler_chat_send(msg_out);
}

int model_handler_cue_play(const char *filename)
{
	char msg[BT_MESH_CHAT_CLI_MSG_MAXLEN_MESSAGE];

	return cue_build_and_send("play", filename, msg, sizeof(msg));
}

int model_handler_cue_find(const char *filename)
{
	char msg[BT_MESH_CHAT_CLI_MSG_MAXLEN_MESSAGE];

	return cue_build_and_send("find", filename, msg, sizeof(msg));
}

int model_handler_cue_list(void)
{
	char msg[BT_MESH_CHAT_CLI_MSG_MAXLEN_MESSAGE];

	return cue_build_and_send("list", "", msg, sizeof(msg));
}

int model_handler_cue_volume_get(void)
{
    char msg[BT_MESH_CHAT_CLI_MSG_MAXLEN_MESSAGE];

    return cue_build_and_send("volume_get", "", msg, sizeof(msg));
}

int model_handler_cue_volume_set(uint8_t percent)
{
    char msg[BT_MESH_CHAT_CLI_MSG_MAXLEN_MESSAGE];
    char value[8];

    if (percent > 100) {
        return -EINVAL;
    }

    snprintf(value, sizeof(value), "%u", percent);
    return cue_build_and_send("volume_set", value, msg, sizeof(msg));
}


static int cue_send(const struct shell *shell, const char *cmd, const char *args)
{
	char msg[BT_MESH_CHAT_CLI_MSG_MAXLEN_MESSAGE];
	int err;

	err = cue_build_and_send(cmd, args, msg, sizeof(msg));
	if (err) {
		LOG_WRN("Failed to send message: %d", err);
	}

	shell_print(shell, "<you>: %s", msg);

	return 0;
}

static int cmd_cue_play(const struct shell *shell, size_t argc, char *argv[])
{
	return cue_send(shell, "play", argv[1]);
}

static int cmd_cue_find(const struct shell *shell, size_t argc, char *argv[])
{
	return cue_send(shell, "find", argv[1]);
}

static int cmd_cue_list(const struct shell *shell, size_t argc, char *argv[])
{
	return cue_send(shell, "list", "");
}

static int cmd_cue_volume_get(const struct shell *shell, size_t argc, char *argv[])
{
    return cue_send(shell, "volume_get", "");
}

static int cmd_cue_volume_set(const struct shell *shell, size_t argc, char *argv[])
{
    char *endptr;
    long percent;

    percent = strtol(argv[1], &endptr, 10);

    if (endptr == argv[1] || *endptr != '\0' ||
        percent < 0 || percent > 100) {
        shell_error(shell, "Volume must be 0-100");
        return -EINVAL;
    }

    return cue_send(shell, "volume_set", argv[1]);
}




SHELL_STATIC_SUBCMD_SET_CREATE(cue_cmds,
	SHELL_CMD_ARG(play, NULL,
		      "Play a file on every mesh node that has it <filename>",
		      cmd_cue_play, 2, 0),
	SHELL_CMD_ARG(find, NULL,
		      "Ask which mesh nodes have a file, without playing it <filename>",
		      cmd_cue_find, 2, 0),
	SHELL_CMD_ARG(list, NULL,
		      "Ask every mesh node to list its playable files",
		      cmd_cue_list, 1, 0),

	SHELL_CMD_ARG(volume_get, NULL,
                  "Ask every mesh node to report its volume",
                  cmd_cue_volume_get, 1, 0),
    SHELL_CMD_ARG(volume_set, NULL,
                  "Set all remote mesh nodes to <percent>",
                  cmd_cue_volume_set, 2, 0),

	SHELL_SUBCMD_SET_END
);

static int cmd_cue(const struct shell *shell, size_t argc, char **argv)
{
	if (argc == 1) {
		shell_help(shell);
		/* shell returns 1 when help is printed */
		return 1;
	}

	shell_error(shell, "%s unknown parameter: %s", argv[0], argv[1]);

	return -EINVAL;
}

SHELL_CMD_ARG_REGISTER(cue, &cue_cmds, "Broadcast a play/find/volume command to the mesh",
		       cmd_cue, 1, 1);

/******************************************************************************/
/******************************** Public API **********************************/
/******************************************************************************/
void model_handler_set_pub(uint16_t addr, uint16_t app_key_idx, uint8_t ttl)
{
	if (!chat.model || !chat.model->pub) {
		return;
	}

	chat.model->pub->addr = addr;
	chat.model->pub->key = app_key_idx;
	chat.model->pub->ttl = ttl;
}

const struct bt_mesh_comp *model_handler_init(void)
{
	chat_shell = shell_backend_uart_get_ptr();

	list_worker_init();

	return &comp;
}

uint16_t model_handler_addr(void)
{
	if (!chat.model) {
		return 0;
	}

	return bt_mesh_model_elem(chat.model)->rt->addr;
}
