-- The dashboard setting "Enable RLS on new tables automatically" creates
-- public.rls_auto_enable(), a SECURITY DEFINER event-trigger function. Because it sits in the
-- exposed public schema, anon and authenticated can call it at /rest/v1/rpc/rls_auto_enable
-- (Supabase advisor lints 0028/0029). Clients have no reason to execute it.
--
-- Revoking EXECUTE doesn't affect the event trigger: event triggers don't check EXECUTE.
--
-- The function only exists where that dashboard setting is on (not on local stacks or
-- fresh projects), so only revoke if it's there.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;
