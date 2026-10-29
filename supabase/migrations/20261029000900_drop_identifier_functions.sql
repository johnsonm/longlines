-- Drop the two sign-in helpers 20261029000600 kept for deployed callers. The sign-in function now
-- refuses anything but an email before any database call, and the web no longer checks a callsign
-- before sign-up, so nothing calls either one.
--
-- callsign_available was the one function anon could execute (advisor.test.sql).

drop function public.callsign_available(text);
drop function public.email_for_identifier(text);
