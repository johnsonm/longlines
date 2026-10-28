-- Sign in with Google. A Google sign-up carries no callsign (signInWithOAuth
-- cannot pass user metadata), so the trigger leaves such a user without a
-- profile, and the web asks for the callsign before anything else and creates
-- the profile through complete_profile. Every profile still has a callsign.

-- handle_new_user from 20261006000001, plus the OAuth case: a user whose
-- provider is not email and who has no callsign gets no profile. An email
-- sign-up (or one with no provider, as the pgTAP tests insert) still fails on
-- a missing, bad or taken callsign.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_callsign text := upper(trim(new.raw_user_meta_data ->> 'callsign'));
  v_provider text := new.raw_app_meta_data ->> 'provider';
begin
  if v_callsign is null and v_provider is not null and v_provider <> 'email' then
    return new;
  end if;
  if v_callsign is null or v_callsign !~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$' then
    raise exception 'Enter a valid amateur callsign.';
  end if;
  if exists (select 1 from profiles p where p.callsign = v_callsign) then
    raise exception 'That callsign is already taken.';
  end if;
  insert into profiles (id, callsign, name)
  values (new.id, v_callsign, coalesce(new.raw_user_meta_data ->> 'name', ''));
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- The caller's profile, for a user who signed up without one (Google). Refuses
-- a caller who already has one: the account page changes the callsign.
create or replace function public.complete_profile(p_callsign text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_callsign text := upper(trim(p_callsign));
begin
  if v_user is null then
    raise exception 'Sign in again.';
  end if;
  if v_callsign is null or v_callsign !~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$' then
    raise exception 'Enter a valid amateur callsign.';
  end if;
  if exists (select 1 from profiles p where p.id = v_user) then
    raise exception 'Your account is already set up.';
  end if;
  insert into profiles (id, callsign, name)
  values (v_user, v_callsign, coalesce(trim(p_name), ''));
exception
  when unique_violation then
    -- Taken by someone else, or a second request for this user won the race.
    if exists (select 1 from profiles p where p.id = v_user) then
      raise exception 'Your account is already set up.';
    end if;
    raise exception 'That callsign is already taken.';
end;
$$;

revoke all on function public.complete_profile(text, text) from public;
grant execute on function public.complete_profile(text, text) to authenticated;
