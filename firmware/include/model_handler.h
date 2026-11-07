/*
 * Copyright (c) 2020 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

/**
 * @file
 * @brief Model handler
 */

#ifndef MODEL_HANDLER_H__
#define MODEL_HANDLER_H__

#include <zephyr/bluetooth/mesh.h>

#include "chat_cli.h"

#ifdef __cplusplus
extern "C" {
#endif

const struct bt_mesh_comp *model_handler_init(void);
void model_handler_set_pub(uint16_t addr, uint16_t app_key_idx, uint8_t ttl);

/** @brief Get the chat model's element address, or 0 if not yet
 * provisioned. Valid after model_handler_init() + bt_mesh_init() +
 * settings_load().
 */
uint16_t model_handler_addr(void);

/** @brief Get this node's provisioning state, address, and current presence. */
void model_handler_status(bool *provisioned, uint16_t *addr,
			  enum bt_mesh_chat_cli_presence *presence);

/** @brief Look up a presence enum value's canonical string, e.g. "available". */
const char *model_handler_presence_to_string(enum bt_mesh_chat_cli_presence presence);

/**
 * @brief Parse a presence string, e.g. "available", into its enum value.
 *
 * @retval true  @p str matched a known presence value; *presence is set.
 * @retval false @p str did not match any known presence value.
 */
bool model_handler_presence_from_string(const char *str,
					enum bt_mesh_chat_cli_presence *presence);

/** @brief Broadcast a chat text message. See bt_mesh_chat_cli_message_send(). */
int model_handler_chat_send(const char *msg);

/** @brief Send a private chat text message. See bt_mesh_chat_cli_private_message_send(). */
int model_handler_chat_send_private(uint16_t addr, const char *msg);

/** @brief Set and publish this node's presence. See bt_mesh_chat_cli_presence_set(). */
int model_handler_presence_set(enum bt_mesh_chat_cli_presence presence);

/** @brief Request another node's presence. See bt_mesh_chat_cli_presence_get(). */
int model_handler_presence_get(uint16_t addr);


/** @brief Send a diagnostic probe to a specific mesh node. */
int model_handler_diag_probe(uint16_t addr, uint32_t probe_id);

/** @brief Broadcast a request to discover arena speaker identities. */
int model_handler_diag_discover(void);

/** @brief Check audio readiness and file availability on a mesh node. */
int model_handler_diag_audio_check(uint16_t addr, const char *filename);

/** @brief Request Heartbeat statistics from a mesh node. */
int model_handler_diag_hb_get(uint16_t addr);

/** @brief Configure local Heartbeat publication. */
int model_handler_diag_hb_publish(uint8_t period_log);

/** @brief Configure local Heartbeat subscription. */
int model_handler_diag_hb_subscribe(uint16_t source_addr);


/** @brief Broadcast "play <filename>" to the mesh (see the cue/chat msg grammar). */
int model_handler_cue_play(const char *filename);

/** @brief Broadcast "find <filename>" to the mesh. */
int model_handler_cue_find(const char *filename);

/** @brief Broadcast "list" to the mesh. */
int model_handler_cue_list(void);


/** @brief Broadcast a volume setting to all remote mesh nodes. */
int model_handler_cue_volume_set(uint8_t percent);

/** @brief Request current volume levels from remote mesh nodes. */
int model_handler_cue_volume_get(void);


#ifdef __cplusplus
}
#endif

#endif /* MODEL_HANDLER_H__ */
