-- Licenses are read only through callsign_profile(), behind the callsign-profile
-- Edge Function. 20261012000050 let anon and authenticated select
-- callsign_licenses directly, which bypassed hidden_callsigns: a hidden call's
-- profile shows no license, but the table still returned it, and the mismatch
-- told anyone that the call was hidden. No client reads the table; the web app
-- gets licenses from the function.
drop policy callsign_licenses_read on callsign_licenses;
revoke all on callsign_licenses from anon, authenticated;
