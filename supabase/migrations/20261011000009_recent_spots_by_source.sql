-- Recent spots on the Sources page, one source at a time.
--
-- list_recent_spots(int) returned the newest spots of every source from
-- raw_spots and the page filtered them by tab. raw_spots holds only the RBN
-- spots of watched callsigns, so the RBN tab was empty without a subscription;
-- and the whole RBN feed is busy enough that a shared newest-N list would be
-- nearly all RBN. Each tab now asks for its own source.
--
-- RBN rows come from rbn_spots, the whole feed, in the recent_spots shape. They
-- have no id. The comment is formatted as rbnComment in _shared/rbn.ts formats
-- it, so an RBN spot reads the same here as in raw_spots and deliveries. Only
-- one branch returns rows; each keeps its own index order and limit.

drop function public.list_recent_spots(int);

create function public.list_recent_spots(p_source text, max_rows int)
returns setof recent_spots
language sql
stable
security definer
set search_path = public
as $$
  (select * from recent_spots
   where p_source <> 'rbn' and source = p_source
   order by spot_time desc
   limit max_rows)
  union all
  (select null::bigint, r.spot_time, r.callsign, r.spotter, r.frequency_khz, r.band, r.mode, r.mode_family,
          format('%s dB %s %s %s', r.snr, r.speed, r.speed_unit, r.spot_type),
          null, null, null, null, 'rbn'
   from rbn_spots r
   where p_source = 'rbn' and r.spot_time > now() - interval '24 hours'
   order by r.spot_time desc
   limit max_rows);
$$;

revoke all on function public.list_recent_spots(text, int) from public, anon, authenticated;
grant execute on function public.list_recent_spots(text, int) to authenticated;
