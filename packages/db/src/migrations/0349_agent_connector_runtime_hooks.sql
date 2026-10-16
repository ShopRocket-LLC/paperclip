CREATE OR REPLACE FUNCTION paperclip_record_agent_runtime(p_company uuid, p_agent uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE revision bigint;
BEGIN
  PERFORM 1 FROM agents WHERE company_id = p_company AND id = p_agent
    AND status NOT IN ('pending_approval', 'terminated') FOR NO KEY UPDATE;
  IF FOUND THEN
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (p_company, 'agent_runtime', p_agent, 'update') RETURNING id INTO revision;
  END IF;
  RETURN revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_company_agent_runtimes(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_skill_source_runtimes(p_company uuid, sources uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = p_company
    AND a.status NOT IN ('pending_approval', 'terminated') AND EXISTS (
      SELECT 1 FROM company_skills s WHERE s.company_id = p_company AND s.access_source_id = ANY(sources)
        AND paperclip_agent_selects_runtime_skill(a.adapter_config, a.adapter_type, s.key, s.slug))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_skill_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; keys text[]; company uuid; candidate uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.key, OLD.slug, OLD.markdown, OLD.source_type, OLD.source_locator, OLD.source_ref,
      OLD.file_inventory, OLD.current_version_id, OLD.access_source_id, OLD.compatibility, OLD.trust_level, OLD.metadata)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.key, NEW.slug, NEW.markdown, NEW.source_type, NEW.source_locator, NEW.source_ref,
      NEW.file_inventory, NEW.current_version_id, NEW.access_source_id, NEW.compatibility, NEW.trust_level, NEW.metadata)
    THEN RETURN NEW; END IF;
  company := coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid);
  SELECT array_agg(DISTINCT lower(reference)) INTO keys FROM (
    SELECT row->>'key' AS reference FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT regexp_replace(row->>'key', '.*/', '') FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT CASE WHEN row->>'key' LIKE 'paperclipai/paperclip/%' THEN row->>'slug'
      ELSE (row->>'slug') || '--' || left(encode(sha256(convert_to(row->>'key', 'UTF8')), 'hex'), 10) END
      FROM unnest(ARRAY[previous, current]) row
  ) refs WHERE reference IS NOT NULL;
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = company
    AND a.status NOT IN ('pending_approval', 'terminated') AND (
      (a.adapter_type <> 'paperclip_runner' AND keys && ARRAY['paperclipai/paperclip/paperclip', 'paperclipai/paperclip/complain', 'paperclipai/paperclip/suggestion-box']) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.adapter_config#>'{paperclipSkillSync,desiredSkills}') = 'array'
        THEN a.adapter_config#>'{paperclipSkillSync,desiredSkills}' ELSE '[]'::jsonb END) choice
        WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(keys)))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(company, candidate);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_connector_company(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE setting text := 'paperclip.runtime_' || replace(p_company::text, '-', '_'); xid text := pg_current_xact_id()::text;
BEGIN
  IF current_setting(setting, true) IS NOT DISTINCT FROM xid THEN RETURN; END IF;
  PERFORM paperclip_invalidate_company_agent_runtimes(p_company);
  PERFORM set_config(setting, xid, true);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; query text; binding record; candidate uuid;
  old_projection text := '(to_jsonb(o) - $1)'; new_projection text := '(to_jsonb(n) - $1)';
  ignored text[] := ARRAY['updated_at', 'created_at', 'last_used_at', 'last_resolved_at', 'last_health_at',
    'health_status', 'health_checked_at', 'health_message', 'last_catalog_refresh_at', 'last_seen_at', 'last_error', 'last_event_at', 'last_publication_at',
    'last_sync_at', 'sync_checkpoint', 'activation_at', 'lease_token', 'lease_expires_at'];
BEGIN
  IF TG_TABLE_NAME = 'company_secret_bindings' THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM new_rows ORDER BY company_id, target_id';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM old_rows ORDER BY company_id, target_id';
    ELSE query := 'WITH changed AS (
      SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1)), targets AS (
      SELECT previous AS target FROM changed UNION SELECT current FROM changed)
      SELECT DISTINCT (target->>''company_id'')::uuid AS company_id, target->>''target_type'' AS target_type, target->>''target_id'' AS target_id
      FROM targets WHERE target IS NOT NULL ORDER BY company_id, target_id';
    END IF;
    FOR binding IN EXECUTE query USING ignored LOOP
      IF binding.target_type = 'agent' THEN
        SELECT id INTO candidate FROM agents WHERE company_id = binding.company_id AND id::text = binding.target_id;
        IF FOUND THEN PERFORM paperclip_record_agent_runtime(binding.company_id, candidate); END IF;
      ELSE PERFORM paperclip_invalidate_connector_company(binding.company_id);
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'tool_policies' THEN
    old_projection := old_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
    new_projection := new_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
  END IF;
  IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id FROM new_rows ORDER BY company_id';
  ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id FROM old_rows ORDER BY company_id';
  ELSE query := format('WITH changed AS (
    SELECT o.company_id AS old_company, n.company_id AS new_company FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
    WHERE %s IS DISTINCT FROM %s)
    SELECT old_company AS company_id FROM changed WHERE old_company IS NOT NULL UNION
    SELECT new_company AS company_id FROM changed WHERE new_company IS NOT NULL ORDER BY company_id', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
  END IF;
  FOR company IN EXECUTE query USING ignored LOOP
    PERFORM paperclip_invalidate_connector_company(company);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE relation text; key_column text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['tool_applications', 'tool_connections', 'connection_grants', 'connection_grant_members',
    'connection_grant_delegations', 'tool_connection_installs', 'tool_catalog_entries', 'tool_profiles', 'tool_profile_entries',
    'tool_profile_bindings', 'tool_policies', 'tool_mcp_gateways', 'company_memberships', 'principal_permission_grants',
    'company_secret_bindings', 'chat_endpoints', 'chat_endpoint_resources', 'chat_agent_routes', 'chat_identity_links',
    'chat_voice_callbacks', 'email_endpoints'] LOOP
    key_column := CASE WHEN relation = 'email_endpoints' THEN 'endpoint_id' ELSE 'id' END;
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_insert ON %I', relation);
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_update ON %I', relation);
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_delete ON %I', relation);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%L)', relation, key_column);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%L)', relation, key_column);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%L)', relation, key_column);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_uses_secret(p_company uuid, p_secret uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tool_connections WHERE company_id = p_company AND (
      credential_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)) OR
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)))) OR
    EXISTS (SELECT 1 FROM connection_grants WHERE company_id = p_company AND
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_secret_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE secret uuid; company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_build_array(OLD.status, OLD.latest_version, OLD.deleted_at, OLD.external_ref, OLD.provider_config_id, OLD.provider_metadata)
    IS NOT DISTINCT FROM jsonb_build_array(NEW.status, NEW.latest_version, NEW.deleted_at, NEW.external_ref, NEW.provider_config_id, NEW.provider_metadata) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN secret := OLD.id; company := OLD.company_id;
  ELSE secret := NEW.id; company := NEW.company_id; END IF;
  IF paperclip_connector_uses_secret(company, secret) THEN
    PERFORM paperclip_invalidate_connector_company(company);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_connector_secret_changed ON company_secrets;
CREATE TRIGGER paperclip_connector_secret_changed AFTER UPDATE OR DELETE ON company_secrets
  FOR EACH ROW EXECUTE FUNCTION paperclip_connector_secret_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_vault_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE vault uuid; company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_build_array(OLD.provider, OLD.status, OLD.config, OLD.is_default, OLD.disabled_at)
    IS NOT DISTINCT FROM jsonb_build_array(NEW.provider, NEW.status, NEW.config, NEW.is_default, NEW.disabled_at) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN vault := OLD.id; ELSE vault := NEW.id; END IF;
  FOR company IN SELECT DISTINCT s.company_id FROM company_secrets s WHERE s.provider_config_id = vault
    AND paperclip_connector_uses_secret(s.company_id, s.id) ORDER BY s.company_id LOOP
    PERFORM paperclip_invalidate_connector_company(company);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_connector_vault_changed ON company_secret_provider_configs;
CREATE TRIGGER paperclip_connector_vault_changed AFTER INSERT OR UPDATE OR DELETE ON company_secret_provider_configs
  FOR EACH ROW EXECUTE FUNCTION paperclip_connector_vault_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_flags_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; previous jsonb := coalesce(to_jsonb(OLD)->'experimental', '{}'::jsonb);
  current jsonb := coalesce(to_jsonb(NEW)->'experimental', '{}'::jsonb);
BEGIN
  IF jsonb_build_array(coalesce(previous->'enablePublicMcp', 'false'::jsonb), coalesce(previous->'enableChatConnectors', 'false'::jsonb))
    IS DISTINCT FROM jsonb_build_array(coalesce(current->'enablePublicMcp', 'false'::jsonb), coalesce(current->'enableChatConnectors', 'false'::jsonb)) THEN
    FOR company IN SELECT DISTINCT company_id FROM agents ORDER BY company_id LOOP
      PERFORM paperclip_invalidate_connector_company(company);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_connector_flags_runtime_changed ON instance_settings;
CREATE TRIGGER paperclip_connector_flags_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON instance_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_connector_flags_runtime_changed();
