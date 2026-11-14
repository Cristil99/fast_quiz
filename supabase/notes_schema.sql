-- fast_quiz notes schema v1. Run the whole file in Supabase SQL Editor.
-- Rerunnable: no table/data deletion; only this feature's policies/functions/trigger.
begin;

create table if not exists public.quiz_notes (
    user_id uuid not null references auth.users(id) on delete cascade,
    identity_hash bytea not null,
    question_key text not null check (length(question_key) > 0),
    note_id text not null check (length(note_id) > 0),
    content text not null check (content ~ '[^[:space:]]'),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
    version bigint not null default 1 check (version > 0),
    primary key (user_id, identity_hash)
);

comment on table public.quiz_notes is
'fast_quiz v1; complete text identity retained, bounded SHA-256 index, server versions, no client DELETE.';

create or replace function public.quiz_notes_stamp_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
    if tg_op = 'UPDATE' then
        if new.user_id is distinct from old.user_id
            or new.question_key is distinct from old.question_key
            or new.note_id is distinct from old.note_id then
            raise exception 'Note identity is immutable' using errcode = '22023';
        end if;
        new.version := old.version + 1;
    else
        new.version := 1;
    end if;
    -- NUL cannot occur in PostgreSQL text, so this separator is unambiguous.
    new.identity_hash := sha256(convert_to(new.question_key, 'UTF8')
        || decode('00', 'hex') || convert_to(new.note_id, 'UTF8'));
    return new;
end;
$$;

drop trigger if exists quiz_notes_stamp_v1 on public.quiz_notes;
create trigger quiz_notes_stamp_v1
before insert or update on public.quiz_notes
for each row execute function public.quiz_notes_stamp_v1();

alter table public.quiz_notes enable row level security;

drop policy if exists quiz_notes_select_own_v1 on public.quiz_notes;
create policy quiz_notes_select_own_v1 on public.quiz_notes
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists quiz_notes_insert_own_v1 on public.quiz_notes;
create policy quiz_notes_insert_own_v1 on public.quiz_notes
for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists quiz_notes_update_own_v1 on public.quiz_notes;
create policy quiz_notes_update_own_v1 on public.quiz_notes
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- No broad/default privilege changes. Automatically expose new tables may stay OFF.
revoke all on table public.quiz_notes from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update on table public.quiz_notes to authenticated;

-- This RPC constructs user_id from the authenticated identity and also checks
-- p_user_id to prevent an old browser task using a newly switched account session.
create or replace function public.quiz_notes_write_v1(
    p_user_id uuid,
    p_question_key text,
    p_note_id text,
    p_content text,
    p_created_at timestamptz,
    p_updated_at timestamptz,
    p_metadata jsonb,
    p_expected_version bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
    owner_id uuid := auth.uid();
    result public.quiz_notes%rowtype;
    fingerprint bytea;
begin
    if owner_id is null or p_user_id is distinct from owner_id then
        raise exception 'Authenticated account mismatch' using errcode = '42501';
    end if;
    fingerprint := sha256(convert_to(p_question_key, 'UTF8')
        || decode('00', 'hex') || convert_to(p_note_id, 'UTF8'));

    if p_expected_version is null then
        insert into public.quiz_notes
            (user_id, question_key, note_id, content, created_at, updated_at, metadata)
        values
            (owner_id, p_question_key, p_note_id, p_content, p_created_at, p_updated_at, p_metadata)
        on conflict (user_id, identity_hash) do nothing
        returning * into result;
        if found then
            return jsonb_build_object('status', 'ok', 'note', to_jsonb(result));
        end if;
    else
        if p_expected_version < 1 then
            raise exception 'Invalid expected version' using errcode = '22023';
        end if;
        -- PostgreSQL checks the version again after waiting for a concurrent writer.
        update public.quiz_notes
        set content = p_content, created_at = p_created_at,
            updated_at = p_updated_at, metadata = p_metadata
        where user_id = owner_id and identity_hash = fingerprint
            and question_key = p_question_key and note_id = p_note_id
            and version = p_expected_version
        returning * into result;
        if found then
            return jsonb_build_object('status', 'ok', 'note', to_jsonb(result));
        end if;
    end if;

    select * into result from public.quiz_notes
    where user_id = owner_id and identity_hash = fingerprint;
    if not found then
        return jsonb_build_object('status', 'missing');
    end if;
    -- Never treat different full keys as the same note, even on a hash collision.
    if result.question_key is distinct from p_question_key or result.note_id is distinct from p_note_id then
        raise exception 'Identity hash collision; original note retained' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'conflict', 'note', to_jsonb(result));
end;
$$;

revoke all on function public.quiz_notes_stamp_v1() from public, anon, authenticated;
revoke all on function public.quiz_notes_write_v1(uuid, text, text, text, timestamptz, timestamptz, jsonb, bigint)
    from public, anon, authenticated;
grant execute on function public.quiz_notes_write_v1(uuid, text, text, text, timestamptz, timestamptz, jsonb, bigint)
    to authenticated;

-- Refresh PostgREST's schema cache after this transaction commits.
notify pgrst, 'reload schema';
commit;
