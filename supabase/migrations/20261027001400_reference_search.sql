-- Reference profiles, PR 5: the Reference lookup search
-- (docs/superpowers/specs/2026-10-26-reference-profiles-design.md, decision 11).
--
-- search_references(query, program) finds POTA parks, SOTA summits and WWFF references by their
-- reference or their list name. Its shape is ReferenceSearch in web/src/references/types.ts, read
-- by the reference-search function's Zod schema and pinned by supabase/tests/reference_search.test.sql;
-- change the SQL, the type, the schema and the test together. It is not granted to clients: the
-- public reference-search function calls it after record_profile_lookup, the callsign profile's
-- rate limit, and refuses a malformed query with a 400 before any database call.
--
-- A search is every whitespace-separated word of the trimmed query, upper-cased, found with strpos
-- (never like, so % and _ are literal) in the reference or the upper-cased list name. A word holds
-- no whitespace, so it cannot match across the space that joins the two. It reads only
-- reference_catalog and reference_days: no live days, since a search is not a profile. Activations
-- are distinct (base, day) pairs, hidden calls left out (decision 7). Every matching list row comes
-- back, retired ones and ones never activated included, ordered by activations, then reference;
-- the first 25, and whether there were more. No new index (the spec's Schema section): the catalog
-- is scanned once, and each match reads only its own range of reference_days' primary key.
--
-- The result header is reference_profile's catalog header without latitude, longitude and
-- validFrom. reference_catalog_header(row) states that header once; reference_profile still builds
-- it inline (20261027001200), and the pgTAP test checks the two agree for each program.

-- ---------------------------------------------------------------------------
-- 1. reference_catalog_header: reference_profile's `catalog` object for one list row
-- ---------------------------------------------------------------------------

-- SOTA's region is stored "<AssociationName>, <RegionName>" (association names have no comma;
-- region names may); the header gives the association code and RegionName.
create function public.reference_catalog_header(c public.reference_catalog)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
           'name', c.name,
           'active', c.active,
           'location', c.location,
           'association', case when c.program = 'sota' then split_part(c.reference, '/', 1) end,
           'region', case when c.program = 'sota' and strpos(c.region, ', ') > 0
                          then substr(c.region, strpos(c.region, ', ') + 2)
                          else c.region end,
           'country', c.country,
           'latitude', c.latitude,
           'longitude', c.longitude,
           'grid', c.grid,
           'altitudeM', c.altitude_m,
           'points', c.points,
           'validFrom', to_char(c.valid_from, 'YYYY-MM-DD'),
           'validTo', to_char(c.valid_to, 'YYYY-MM-DD'));
$$;

-- ---------------------------------------------------------------------------
-- 2. search_references
-- ---------------------------------------------------------------------------

-- {results: [{program, reference, name, active, validTo, location, association, region, country,
-- grid, altitudeM, points, activations, lastDay}], more}, or null for a query that is not 2 to 64
-- characters after trimming, has more than 6 words, or a program other than pota, sota or wwff
-- (null searches all three).
create function public.search_references(p_query text, p_program text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_query   text := regexp_replace(coalesce(p_query, ''), '^\s+|\s+$', '', 'g');
  v_program text := lower(btrim(p_program));
  v_words   text[];
  v_count   int;
  v_payload jsonb;
begin
  if p_program is not null and v_program not in ('pota', 'sota', 'wwff') then
    return null;
  end if;
  if char_length(v_query) < 2 or char_length(v_query) > 64 then
    return null;
  end if;
  v_words := regexp_split_to_array(upper(v_query), '\s+');
  v_count := cardinality(v_words);
  if v_count > 6 then
    return null;
  end if;
  -- Six words always; strpos(text, '') is 1, so a padding word matches every row.
  v_words := v_words || array_fill(''::text, array[6 - v_count]);

  with
  -- Every list row with every word in its reference or name: one scan of the catalog.
  matched as materialized (
    select c.program, c.reference
    from (select c.program, c.reference, c.reference || ' ' || upper(coalesce(c.name, '')) as hay
          from reference_catalog c
          where p_program is null or c.program = v_program) c
    where strpos(c.hay, v_words[1]) > 0 and strpos(c.hay, v_words[2]) > 0
      and strpos(c.hay, v_words[3]) > 0 and strpos(c.hay, v_words[4]) > 0
      and strpos(c.hay, v_words[5]) > 0 and strpos(c.hay, v_words[6]) > 0
  ),
  -- Each match's activations and last day from its own range of reference_days' primary key
  -- (program, reference, day, base, source), so the cost follows the matches, never the whole
  -- table, and no large set is joined to another. count(distinct) sorts each range's few rows; a
  -- distinct subquery would build a hash table per match, several times slower over 200,000 of
  -- them. The top 25 and one more, to tell whether there were more.
  top as (
    select m.program, m.reference, t.activations, t.last_day
    from matched m
    cross join lateral (
      select count(distinct (d.day, d.base))::int as activations, max(d.day) as last_day
      from reference_days d
      where d.program = m.program and d.reference = m.reference
        and not exists (select 1 from hidden_callsigns h where h.callsign = d.base)) t
    order by t.activations desc, m.reference, m.program
    limit 26
  ),
  ranked as (
    select t.program, t.reference, t.activations, t.last_day,
           row_number() over (order by t.activations desc, t.reference, t.program) as n
    from top t
  )
  select jsonb_build_object(
           'results', coalesce(jsonb_agg(
             jsonb_build_object('program', r.program, 'reference', r.reference)
             || (public.reference_catalog_header(c) - 'latitude' - 'longitude' - 'validFrom')
             || jsonb_build_object('activations', r.activations,
                                   'lastDay', to_char(r.last_day, 'YYYY-MM-DD'))
             order by r.n) filter (where r.n <= 25), '[]'::jsonb),
           'more', count(*) > 25)
    into v_payload
  from ranked r
  join reference_catalog c on c.program = r.program and c.reference = r.reference;

  return v_payload;
end;
$$;

revoke all on function public.reference_catalog_header(public.reference_catalog) from public, anon, authenticated;
revoke all on function public.search_references(text, text) from public, anon, authenticated;
grant execute on function public.search_references(text, text) to service_role;
