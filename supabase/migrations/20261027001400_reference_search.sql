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
-- is scanned once, and the activations come one of two ways, whichever reads less. A search with
-- few matches reads each match's own range of reference_days' primary key (about 9 us a match); one
-- with many reads the whole primary key once, grouped, in its own order (about 0.4 us a row), and
-- joins the matches to that. search_references switches when the matches pass a twentieth of
-- reference_days' rows (pg_class.reltuples), where the two cost about the same. Measured at about
-- 350,000 list rows and 2,000,000 reference_days rows (docs/ARCHITECTURE.md): 0.2 s for a few
-- matches, 0.7 s for 63,000, and 1.2 s for a search such as `- -` that matches every row. The
-- worst case grows with reference_days, at about 0.4 s a million rows.
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
-- (null searches all three). p_grouped_from is the number of matches from which the activations
-- come from one grouped pass over reference_days rather than one probe a match; both give the same
-- payload, and search_references picks it (the pgTAP test runs both ways).
create function public.search_references_at(p_query text, p_program text, p_grouped_from bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
-- Plan each call with its words and program as constants: a cached generic plan cannot use the
-- program to narrow the grouped pass and was measured several times slower.
set plan_cache_mode = force_custom_plan
as $$
declare
  v_query   text := regexp_replace(coalesce(p_query, ''), '^\s+|\s+$', '', 'g');
  v_program text := lower(btrim(p_program));
  v_words   text[];
  v_count   int;
  v_hidden  text[];
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
  -- Hidden calls count nowhere (decision 7). A constant list keeps the grouped pass a plain
  -- filter on the primary key's order, where an anti-join would lose it.
  v_hidden := array(select h.callsign from hidden_callsigns h);

  with
  -- Every list row with every word in its reference or name: one scan of the catalog. offset 0
  -- keeps the subquery whole, so the upper-cased text is built once a row, not once a word.
  matched as materialized (
    select c.program, c.reference
    from (select c.program, c.reference, c.reference || ' ' || upper(coalesce(c.name, '')) as hay
          from reference_catalog c
          where p_program is null or c.program = v_program
          offset 0) c
    where strpos(c.hay, v_words[1]) > 0 and strpos(c.hay, v_words[2]) > 0
      and strpos(c.hay, v_words[3]) > 0 and strpos(c.hay, v_words[4]) > 0
      and strpos(c.hay, v_words[5]) > 0 and strpos(c.hay, v_words[6]) > 0
  ),
  size as materialized (select count(*) as n from matched),
  -- Few matches: each one's activations and last day from its own range of the primary key
  -- (program, reference, day, base, source). count(distinct) sorts each range's few rows; a
  -- distinct subquery would build a hash table per match, several times slower.
  probed as (
    select m.program, m.reference, t.activations, t.last_day
    from matched m
    cross join lateral (
      select count(distinct (d.day, d.base))::int as activations, max(d.day) as last_day
      from reference_days d
      where d.program = m.program and d.reference = m.reference
        and d.base <> all(v_hidden)) t
    where (select s.n from size s) < p_grouped_from
  ),
  -- Many matches: every reference's activations in one pass over the primary key, in its order
  -- (the inner group is one (day, base) pair; the outer counts them), joined to the matches. A
  -- match never activated has none.
  grouped as (
    select m.program, m.reference, coalesce(a.activations, 0) as activations, a.last_day
    from matched m
    left join (
      select x.program, x.reference, count(*)::int as activations, max(x.day) as last_day
      from (select d.program, d.reference, d.day, d.base
            from reference_days d
            where (p_program is null or d.program = v_program)
              and d.base <> all(v_hidden)
            group by d.program, d.reference, d.day, d.base) x
      group by x.program, x.reference) a on a.program = m.program and a.reference = m.reference
    where (select s.n from size s) >= p_grouped_from
  ),
  -- The top 25 and one more, to tell whether there were more. Only one arm runs: the other's
  -- condition is a one-time filter.
  top as (
    select u.program, u.reference, u.activations, u.last_day
    from (select * from probed union all select * from grouped) u
    order by u.activations desc, u.reference, u.program
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

-- The search the reference-search function calls: the grouped pass once the matches pass a
-- twentieth of reference_days' estimated rows, where it costs about what the probes would.
create function public.search_references(p_query text, p_program text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.search_references_at(
           p_query, p_program,
           (select greatest(c.reltuples, 0)::bigint / 20
            from pg_catalog.pg_class c
            where c.oid = 'public.reference_days'::regclass));
$$;

revoke all on function public.reference_catalog_header(public.reference_catalog) from public, anon, authenticated;
revoke all on function public.search_references_at(text, text, bigint) from public, anon, authenticated;
revoke all on function public.search_references(text, text) from public, anon, authenticated;
grant execute on function public.search_references(text, text) to service_role;
