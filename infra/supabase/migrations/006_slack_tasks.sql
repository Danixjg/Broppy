-- The Slack app's memory: which Jira issue tracks which task, so a repeated task updates the issue instead of
-- duplicating it, and which Slack events and button clicks were already handled. Server key only; no policies.
create table public.slack_task_links (
  org_id text not null,
  project text not null,
  fingerprint text not null,
  title text not null,
  tokens text[] not null,
  issue_key text not null,
  issue_url text not null,
  assignee_slack_id text not null,
  tracked_by text not null,
  channel text not null,
  message_ts text not null,
  mention_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project, fingerprint)
);
create index slack_task_links_recent on public.slack_task_links (org_id, project, updated_at desc);

create table public.slack_claims (
  org_id text not null,
  key text not null,
  claimed_at timestamptz not null default now(),
  primary key (org_id, key)
);

alter table public.slack_task_links enable row level security;
alter table public.slack_claims enable row level security;
revoke all on public.slack_task_links, public.slack_claims from public, anon, authenticated;
grant select, insert, update on public.slack_task_links to service_role;
grant select, insert, delete on public.slack_claims to service_role;

create function public.record_slack_task_repeat(organization text, project_key text, task_fingerprint text,
  repeat_channel text, repeat_ts text)
returns void language sql security invoker set search_path = '' as $$
  update public.slack_task_links
    set mention_count = mention_count + 1, updated_at = now(), channel = repeat_channel, message_ts = repeat_ts
    where org_id = organization and project = project_key and fingerprint = task_fingerprint;
$$;
revoke all on function public.record_slack_task_repeat(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.record_slack_task_repeat(text,text,text,text,text) to service_role;
