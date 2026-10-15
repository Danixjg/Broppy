export const SLACK_BOT_SCOPES = ["channels:history", "channels:read", "chat:write", "commands", "groups:history", "groups:read", "users:read", "users:read.email"];
export function slackManifest(gatewayOrigin: string, callbackUrls: string[]) {
  return {
    display_information: { name: "Broppy", description: "Ask Broppy and review commitments", background_color: "#143234" },
    features: { bot_user: { display_name: "Broppy", always_online: false }, slash_commands: [{ command: "/broppy", description: "Ask Broppy", url: `${gatewayOrigin}/slack/commands`, should_escape: false }],
      shortcuts: [{ name: "Ask Broppy", type: "message", callback_id: "ask_broppy", description: "Ask about this message" }, { name: "Track with Broppy", type: "message", callback_id: "track_broppy", description: "Review this commitment" }] },
    oauth_config: { redirect_urls: callbackUrls, scopes: { bot: SLACK_BOT_SCOPES } },
    settings: { event_subscriptions: { request_url: `${gatewayOrigin}/slack/events`, bot_events: ["message.channels", "message.groups", "member_joined_channel", "app_uninstalled", "tokens_revoked"] },
      interactivity: { is_enabled: true, request_url: `${gatewayOrigin}/slack/interactions` }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false }
  };
}
