use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use indexmap::IndexMap;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_RESTRICTED_GRANT_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
enum Tier {
    Open,
    Internal,
    Restricted,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Visibility {
    Public,
    Private,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "source",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum NativePermission {
    Slack {
        channel_id: String,
        visibility: Visibility,
        members: Vec<String>,
    },
    Jira {
        project_key: String,
        project_viewers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        issue_viewers: Option<Vec<String>>,
    },
    Confluence {
        space_key: String,
        space_viewers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page_viewers: Option<Vec<String>>,
    },
    Drive {
        file_id: String,
        owner: String,
        shared_users: Vec<String>,
    },
}

impl NativePermission {
    fn source(&self) -> &'static str {
        match self {
            Self::Slack { .. } => "slack",
            Self::Jira { .. } => "jira",
            Self::Confluence { .. } => "confluence",
            Self::Drive { .. } => "drive",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SourcePermission {
    users: Vec<String>,
    groups: Vec<String>,
    public: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native: Option<NativePermission>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    id: String,
    email: String,
    groups: Vec<String>,
    #[serde(default)]
    contractor: bool,
    #[serde(default)]
    platform_identities: Option<IndexMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestrictedGrant {
    user_id: String,
    owner: String,
    reason: String,
    expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Grant {
    permissions: SourcePermission,
    tier: Tier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocked: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exceptions: Option<Vec<RestrictedGrant>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentGrant {
    doc_id: String,
    permissions: SourcePermission,
    tier: Tier,
}

#[derive(Default, Debug, Deserialize)]
struct ImportScope {
    mode: Option<String>,
    containers: Option<Vec<String>>,
    ids: Option<Vec<String>>,
}

fn field<T: DeserializeOwned>(input: &Value, name: &str) -> Result<T, String> {
    let value = input.get(name).ok_or_else(|| format!("Missing {name}"))?;
    serde_json::from_value(value.clone()).map_err(|error| format!("Invalid {name}: {error}"))
}

fn contains(values: &[String], value: &str) -> bool {
    values.iter().any(|candidate| candidate == value)
}

fn is_javascript_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn native_allows(user: &User, permission: &SourcePermission) -> bool {
    let direct = contains(&permission.users, &user.email);
    if user.contractor && !direct {
        return false;
    }
    if !(permission.public
        || direct
        || permission
            .groups
            .iter()
            .any(|group| contains(&user.groups, group)))
    {
        return false;
    }
    let Some(native) = &permission.native else {
        return false;
    };
    let Some(identity) = user
        .platform_identities
        .as_ref()
        .and_then(|identities| identities.get(native.source()))
        .filter(|identity| !identity.is_empty())
    else {
        return false;
    };
    match native {
        NativePermission::Slack {
            visibility,
            members,
            ..
        } => (!user.contractor && *visibility == Visibility::Public) || contains(members, identity),
        NativePermission::Jira {
            project_viewers,
            issue_viewers,
            ..
        } => {
            contains(project_viewers, identity)
                && issue_viewers
                    .as_ref()
                    .is_none_or(|viewers| contains(viewers, identity))
        }
        NativePermission::Confluence {
            space_viewers,
            page_viewers,
            ..
        } => {
            contains(space_viewers, identity)
                && page_viewers
                    .as_ref()
                    .is_none_or(|viewers| contains(viewers, identity))
        }
        NativePermission::Drive {
            owner,
            shared_users,
            ..
        } => owner == identity || contains(shared_users, identity),
    }
}

fn tier_allows(user: &User, tier: Tier) -> bool {
    if user.contractor {
        return tier != Tier::Restricted;
    }
    match tier {
        Tier::Open => true,
        Tier::Internal => !contains(&user.groups, "interns"),
        Tier::Restricted => ["security", "fraud-ops", "compliance"]
            .iter()
            .any(|group| contains(&user.groups, group)),
    }
}

fn subset(next: &[String], current: &[String]) -> bool {
    next.iter().all(|value| contains(current, value))
}

fn restriction_subset(next: &Option<Vec<String>>, current: &Option<Vec<String>>) -> bool {
    current
        .as_ref()
        .is_none_or(|current| next.as_ref().is_some_and(|next| subset(next, current)))
}

fn native_subset(next: &NativePermission, current: &NativePermission) -> bool {
    match (next, current) {
        (
            NativePermission::Slack {
                channel_id: next_id,
                visibility: next_visibility,
                members: next_members,
            },
            NativePermission::Slack {
                channel_id,
                visibility,
                members,
            },
        ) => {
            next_id == channel_id
                && (*visibility == Visibility::Public
                    || (*next_visibility == Visibility::Private && subset(next_members, members)))
        }
        (
            NativePermission::Jira {
                project_key: next_key,
                project_viewers: next_viewers,
                issue_viewers: next_restriction,
            },
            NativePermission::Jira {
                project_key,
                project_viewers,
                issue_viewers,
            },
        ) => {
            next_key == project_key
                && subset(next_viewers, project_viewers)
                && restriction_subset(next_restriction, issue_viewers)
        }
        (
            NativePermission::Confluence {
                space_key: next_key,
                space_viewers: next_viewers,
                page_viewers: next_restriction,
            },
            NativePermission::Confluence {
                space_key,
                space_viewers,
                page_viewers,
            },
        ) => {
            next_key == space_key
                && subset(next_viewers, space_viewers)
                && restriction_subset(next_restriction, page_viewers)
        }
        (
            NativePermission::Drive {
                file_id: next_id,
                owner: next_owner,
                shared_users: next_users,
            },
            NativePermission::Drive {
                file_id,
                owner,
                shared_users,
            },
        ) => next_id == file_id && next_owner == owner && subset(next_users, shared_users),
        _ => false,
    }
}

fn parse_date(value: &str) -> Option<i64> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    if let Ok(date) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(date.and_utc().timestamp_millis());
    }
    DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "policy.nativeAllows" => Ok(json!(native_allows(
            &field(&input, "user")?,
            &field(&input, "permission")?
        ))),
        "policy.tierAllows" => Ok(json!(tier_allows(
            &field(&input, "user")?,
            field(&input, "tier")?
        ))),
        "policy.nativeSubset" => Ok(json!(native_subset(
            &field(&input, "next")?,
            &field(&input, "current")?
        ))),
        "policy.selectsNothing" => {
            let scope: ImportScope = field(&input, "scope")?;
            Ok(json!(
                scope.mode.as_deref() == Some("none")
                    || (scope.mode.as_deref() == Some("selected")
                        && scope.containers.as_ref().is_none_or(Vec::is_empty)
                        && scope.ids.as_ref().is_none_or(Vec::is_empty))
            ))
        }
        _ => Err(format!("Unknown policy operation: {operation}")),
    }
}

#[derive(Default)]
pub struct PolicyStore {
    grants: IndexMap<String, Grant>,
}

impl PolicyStore {
    fn require(&mut self, doc_id: &str) -> Result<&mut Grant, String> {
        self.grants
            .get_mut(doc_id)
            .ok_or_else(|| "Unknown document".to_string())
    }

    fn check(&self, user: &User, doc_id: &str, now: i64) -> Value {
        let Some(grant) = self.grants.get(doc_id) else {
            return json!({ "docId": doc_id, "allowed": false, "reason": "fga" });
        };
        let reason = if !native_allows(user, &grant.permissions) {
            Some("fga")
        } else if grant
            .blocked
            .as_ref()
            .is_some_and(|blocked| contains(blocked, &user.id))
        {
            Some("blocked")
        } else if !tier_allows(user, grant.tier)
            && !(grant.tier == Tier::Restricted
                && grant.exceptions.as_ref().is_some_and(|exceptions| {
                    exceptions.iter().any(|exception| {
                        exception.user_id == user.id
                            && parse_date(&exception.expires_at).is_some_and(|expiry| expiry > now)
                    })
                }))
        {
            Some("tier")
        } else {
            None
        };
        json!({ "docId": doc_id, "allowed": reason.is_none(), "reason": reason.unwrap_or("fga") })
    }

    pub fn execute(&mut self, operation: &str, input: Value) -> Result<Value, String> {
        match operation {
            "snapshot" => serde_json::to_value(self.grants.iter().collect::<Vec<_>>())
                .map_err(|error| error.to_string()),
            "restore" => {
                let entries: Vec<(String, Grant)> = field(&input, "grants")?;
                self.grants = entries.into_iter().collect();
                Ok(Value::Null)
            }
            "upsert" => {
                let doc: DocumentGrant = field(&input, "doc")?;
                let existing = self.grants.get(&doc.doc_id);
                let grant = Grant {
                    permissions: doc.permissions,
                    tier: existing.map_or(doc.tier, |grant| grant.tier.max(doc.tier)),
                    blocked: existing.and_then(|grant| grant.blocked.clone()),
                    exceptions: existing.and_then(|grant| grant.exceptions.clone()),
                };
                self.grants.insert(doc.doc_id, grant);
                Ok(Value::Null)
            }
            "block" | "unblock" => {
                let doc_id: String = field(&input, "docId")?;
                let user_id: String = field(&input, "userId")?;
                let grant = self.require(&doc_id)?;
                let blocked = grant.blocked.get_or_insert_with(Vec::new);
                if operation == "unblock" {
                    blocked.retain(|id| id != &user_id);
                } else if !contains(blocked, &user_id) {
                    blocked.push(user_id);
                }
                Ok(Value::Null)
            }
            "grantRestricted" => {
                let doc_id: String = field(&input, "docId")?;
                let current = self.require(&doc_id)?;
                if current.tier != Tier::Restricted {
                    return Err("Only restricted documents take a restricted grant".to_string());
                }
                let mut grant: RestrictedGrant =
                    field(&input, "grant").map_err(|_| "Invalid restricted grant".to_string())?;
                let now: i64 = field(&input, "now")?;
                let expiry = if input.get("expiresAtMs").is_some() {
                    field::<Option<i64>>(&input, "expiresAtMs")
                        .map_err(|_| "Invalid restricted grant".to_string())?
                } else {
                    parse_date(&grant.expires_at)
                }
                .ok_or_else(|| "Invalid restricted grant".to_string())?;
                if grant.owner.is_empty()
                    || grant
                        .reason
                        .trim_matches(is_javascript_whitespace)
                        .is_empty()
                    || expiry <= now
                    || expiry
                        .checked_sub(now)
                        .is_none_or(|remaining| remaining > MAX_RESTRICTED_GRANT_MS)
                {
                    return Err("Invalid restricted grant".to_string());
                }
                grant.expires_at = DateTime::<Utc>::from_timestamp_millis(expiry)
                    .ok_or_else(|| "Invalid restricted grant".to_string())?
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
                let exceptions = current.exceptions.get_or_insert_with(Vec::new);
                exceptions.retain(|item| item.user_id != grant.user_id);
                exceptions.push(grant);
                Ok(Value::Null)
            }
            "sweepExpired" => {
                let now: i64 = field(&input, "now")?;
                let mut expired = Vec::new();
                for (doc_id, grant) in &mut self.grants {
                    if let Some(exceptions) = &mut grant.exceptions {
                        exceptions.retain(|item| {
                            let live = parse_date(&item.expires_at).is_some_and(|expiry| expiry > now);
                            if !live {
                                expired.push(json!({ "docId": doc_id, "userId": item.user_id,
                                    "owner": item.owner, "reason": item.reason, "expiresAt": item.expires_at }));
                            }
                            live
                        });
                    }
                }
                Ok(json!(expired))
            }
            "exceptions" => {
                let doc_id: String = field(&input, "docId")?;
                Ok(json!(self
                    .grants
                    .get(&doc_id)
                    .and_then(|grant| grant.exceptions.as_ref())
                    .cloned()
                    .unwrap_or_default()))
            }
            "remove" => {
                let doc_id: String = field(&input, "docId")?;
                self.grants.shift_remove(&doc_id);
                Ok(Value::Null)
            }
            "narrowTier" => {
                let doc_id: String = field(&input, "docId")?;
                let tier: Tier = field(&input, "tier")?;
                let grant = self.require(&doc_id)?;
                if tier < grant.tier {
                    return Err("Admin tier may only narrow access".to_string());
                }
                grant.tier = tier;
                Ok(Value::Null)
            }
            "check" => {
                let user: User = field(&input, "user")?;
                let doc_id: String = field(&input, "docId")?;
                let now: i64 = field(&input, "now")?;
                Ok(self.check(&user, &doc_id, now))
            }
            "batchCheck" => {
                let user: User = field(&input, "user")?;
                let doc_ids: Vec<String> = field(&input, "docIds")?;
                let now: i64 = field(&input, "now")?;
                let mut seen = HashSet::new();
                Ok(json!(doc_ids
                    .into_iter()
                    .filter(|doc_id| seen.insert(doc_id.clone()))
                    .map(|doc_id| self.check(&user, &doc_id, now))
                    .collect::<Vec<_>>()))
            }
            "effectiveTier" => {
                let doc_id: String = field(&input, "docId")?;
                Ok(json!(self.grants.get(&doc_id).map(|grant| grant.tier)))
            }
            _ => Err(format!("Unknown policy store operation: {operation}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> Value {
        json!({ "id": "eve", "email": "eve@brain", "groups": [], "platformIdentities": { "jira": "eve@jira", "slack": "eve@slack" } })
    }

    fn permission() -> Value {
        json!({ "users": ["eve@brain"], "groups": [], "public": false,
            "native": { "source": "jira", "projectKey": "SEC", "projectViewers": ["eve@jira"] } })
    }

    fn restricted_store() -> PolicyStore {
        let mut store = PolicyStore::default();
        store.execute("upsert", json!({ "doc": { "docId": "jira:SEC-1", "permissions": permission(), "tier": "restricted" } })).unwrap();
        store
    }

    fn now() -> i64 {
        parse_date("2026-10-03T00:00:00Z").unwrap()
    }

    #[test]
    fn native_access_intersects_brain_and_platform_permissions() {
        let input = json!({ "user": user(), "permission": permission() });
        assert_eq!(
            dispatch("policy.nativeAllows", input.clone()).unwrap(),
            true
        );
        let mut missing_native = input.clone();
        missing_native["permission"]
            .as_object_mut()
            .unwrap()
            .remove("native");
        assert_eq!(
            dispatch("policy.nativeAllows", missing_native).unwrap(),
            false
        );
        let mut missing_identity = input.clone();
        missing_identity["user"]
            .as_object_mut()
            .unwrap()
            .remove("platformIdentities");
        assert_eq!(
            dispatch("policy.nativeAllows", missing_identity).unwrap(),
            false
        );
        let mut native_deny = input.clone();
        native_deny["permission"]["native"]["issueViewers"] = json!([]);
        assert_eq!(dispatch("policy.nativeAllows", native_deny).unwrap(), false);
        let mut brain_deny = input;
        brain_deny["permission"]["users"] = json!([]);
        assert_eq!(dispatch("policy.nativeAllows", brain_deny).unwrap(), false);
    }

    #[test]
    fn contractors_need_direct_brain_grant_and_native_membership() {
        let mut user = user();
        user["contractor"] = json!(true);
        let mut permission = json!({ "users": [], "groups": [], "public": true,
            "native": { "source": "slack", "channelId": "C1", "visibility": "public", "members": ["eve@slack"] } });
        assert_eq!(
            dispatch(
                "policy.nativeAllows",
                json!({ "user": user, "permission": permission })
            )
            .unwrap(),
            false
        );
        permission["users"] = json!(["eve@brain"]);
        assert_eq!(
            dispatch(
                "policy.nativeAllows",
                json!({ "user": user, "permission": permission })
            )
            .unwrap(),
            true
        );
        permission["native"]["members"] = json!([]);
        assert_eq!(
            dispatch(
                "policy.nativeAllows",
                json!({ "user": user, "permission": permission })
            )
            .unwrap(),
            false
        );
    }

    #[test]
    fn exceptions_expire_and_blocks_survive_sync_without_widening_tier() {
        let mut store = restricted_store();
        let check = json!({ "user": user(), "docId": "jira:SEC-1", "now": now() });
        assert_eq!(
            store.execute("check", check.clone()).unwrap()["reason"],
            "tier"
        );
        let expiry = now() + 1000;
        store.execute("grantRestricted", json!({ "docId": "jira:SEC-1", "grant": { "userId": "eve", "owner": "maya", "reason": "review", "expiresAt": DateTime::<Utc>::from_timestamp_millis(expiry).unwrap().to_rfc3339() }, "now": now() })).unwrap();
        assert_eq!(
            store.execute("check", check.clone()).unwrap()["allowed"],
            true
        );
        store
            .execute("block", json!({ "docId": "jira:SEC-1", "userId": "eve" }))
            .unwrap();
        store.execute("upsert", json!({ "doc": { "docId": "jira:SEC-1", "permissions": permission(), "tier": "open" } })).unwrap();
        assert_eq!(
            store.execute("check", check.clone()).unwrap()["reason"],
            "blocked"
        );
        assert_eq!(
            store
                .execute("effectiveTier", json!({ "docId": "jira:SEC-1" }))
                .unwrap(),
            "restricted"
        );
        store
            .execute("unblock", json!({ "docId": "jira:SEC-1", "userId": "eve" }))
            .unwrap();
        let mut expired_check = check;
        expired_check["now"] = json!(expiry);
        assert_eq!(
            store.execute("check", expired_check).unwrap()["allowed"],
            false
        );
        assert_eq!(
            store
                .execute("sweepExpired", json!({ "now": expiry }))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .execute("exceptions", json!({ "docId": "jira:SEC-1" }))
                .unwrap(),
            json!([])
        );
    }

    #[test]
    fn grant_window_and_narrowing_errors_leave_state_unchanged() {
        let mut store = restricted_store();
        let initial = store.execute("snapshot", json!({})).unwrap();
        for expiry in [now(), now() + MAX_RESTRICTED_GRANT_MS + 1] {
            let result = store.execute("grantRestricted", json!({ "docId": "jira:SEC-1", "now": now(), "grant": { "userId": "eve", "owner": "maya", "reason": "review", "expiresAt": DateTime::<Utc>::from_timestamp_millis(expiry).unwrap().to_rfc3339_opts(SecondsFormat::Millis, true) } }));
            assert_eq!(result.unwrap_err(), "Invalid restricted grant");
        }
        assert_eq!(
            store
                .execute(
                    "narrowTier",
                    json!({ "docId": "jira:SEC-1", "tier": "open" })
                )
                .unwrap_err(),
            "Admin tier may only narrow access"
        );
        assert_eq!(store.execute("snapshot", json!({})).unwrap(), initial);
    }

    #[test]
    fn restore_and_batch_preserve_first_insertion_order() {
        let mut store = PolicyStore::default();
        let grant = json!({ "permissions": permission(), "tier": "open" });
        store
            .execute(
                "restore",
                json!({ "grants": [["b", grant], ["a", grant], ["b", grant]] }),
            )
            .unwrap();
        let snapshot = store.execute("snapshot", json!({})).unwrap();
        assert_eq!(snapshot[0][0], "b");
        assert_eq!(snapshot[1][0], "a");
        let decisions = store
            .execute(
                "batchCheck",
                json!({ "user": user(), "docIds": ["a", "a", "b", "unknown"], "now": now() }),
            )
            .unwrap();
        assert_eq!(decisions.as_array().unwrap().len(), 3);
        assert_eq!(decisions[0]["docId"], "a");
        assert_eq!(decisions[1]["docId"], "b");
        assert_eq!(
            decisions[2],
            json!({ "docId": "unknown", "allowed": false, "reason": "fga" })
        );
    }

    #[test]
    fn native_subsets_cannot_remove_existing_item_restrictions() {
        let current = json!({ "source": "jira", "projectKey": "SEC", "projectViewers": ["a", "b"], "issueViewers": ["a"] });
        let next = json!({ "source": "jira", "projectKey": "SEC", "projectViewers": ["a"] });
        assert_eq!(
            dispatch(
                "policy.nativeSubset",
                json!({ "next": next, "current": current })
            )
            .unwrap(),
            false
        );
        let mut next = next;
        next["issueViewers"] = json!([]);
        assert_eq!(
            dispatch(
                "policy.nativeSubset",
                json!({ "next": next, "current": current })
            )
            .unwrap(),
            true
        );
    }

    #[test]
    fn host_parsed_expiry_is_normalized_and_invalid_dates_fail_closed() {
        let mut store = restricted_store();
        let input = json!({ "docId": "jira:SEC-1", "now": now(), "expiresAtMs": now() + 1000,
            "grant": { "userId": "eve", "owner": "maya", "reason": "review", "expiresAt": "October 3, 2026" } });
        store.execute("grantRestricted", input.clone()).unwrap();
        assert_eq!(
            store
                .execute("exceptions", json!({ "docId": "jira:SEC-1" }))
                .unwrap()[0]["expiresAt"],
            "2026-10-03T00:00:01.000Z"
        );
        let mut invalid = input;
        invalid["expiresAtMs"] = Value::Null;
        assert_eq!(
            store.execute("grantRestricted", invalid).unwrap_err(),
            "Invalid restricted grant"
        );
    }

    #[test]
    fn restricted_grant_reason_uses_javascript_whitespace_rules() {
        let mut store = restricted_store();
        let mut input = json!({ "docId": "jira:SEC-1", "now": now(), "expiresAtMs": now() + 1000,
            "grant": { "userId": "eve", "owner": "maya", "reason": "\u{feff}", "expiresAt": "2026-10-03T00:00:01Z" } });
        assert_eq!(
            store.execute("grantRestricted", input.clone()).unwrap_err(),
            "Invalid restricted grant"
        );
        input["grant"]["reason"] = json!("\u{0085}");
        store.execute("grantRestricted", input).unwrap();
    }
}
