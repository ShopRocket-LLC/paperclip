CREATE OR REPLACE FUNCTION paperclip_connector_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; query text;
  ignored text[] := ARRAY['updated_at', 'created_at', 'last_used_at', 'last_resolved_at', 'last_health_at',
    'health_status', 'health_checked_at', 'health_message', 'last_catalog_refresh_at', 'last_error', 'last_event_at', 'last_publication_at',
    'last_sync_at', 'sync_checkpoint', 'activation_at', 'lease_token', 'lease_expires_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id FROM new_rows ORDER BY company_id';
  ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id FROM old_rows ORDER BY company_id';
  ELSE query := format('WITH changed AS (
    SELECT o.company_id AS old_company, n.company_id AS new_company FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
    WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1))
    SELECT old_company AS company_id FROM changed WHERE old_company IS NOT NULL UNION
    SELECT new_company AS company_id FROM changed WHERE new_company IS NOT NULL ORDER BY company_id', TG_ARGV[0], TG_ARGV[0]);
  END IF;
  FOR company IN EXECUTE query USING ignored LOOP
    PERFORM paperclip_invalidate_company_agent_runtimes(company);
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
CREATE OR REPLACE FUNCTION paperclip_connector_secret_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE secret uuid; company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_build_array(OLD.status, OLD.latest_version, OLD.deleted_at, OLD.external_ref, OLD.provider_config_id, OLD.provider_metadata)
    IS NOT DISTINCT FROM jsonb_build_array(NEW.status, NEW.latest_version, NEW.deleted_at, NEW.external_ref, NEW.provider_config_id, NEW.provider_metadata) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN secret := OLD.id; company := OLD.company_id;
  ELSE secret := NEW.id; company := NEW.company_id; END IF;
  IF EXISTS (SELECT 1 FROM tool_connections WHERE company_id = company AND (
      credential_refs @> jsonb_build_array(jsonb_build_object('secretId', secret::text)) OR
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', secret::text)))) OR
    EXISTS (SELECT 1 FROM connection_grants WHERE company_id = company AND
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', secret::text))) THEN
    PERFORM paperclip_invalidate_company_agent_runtimes(company);
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
CREATE OR REPLACE FUNCTION paperclip_connector_flags_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; previous jsonb := coalesce(to_jsonb(OLD)->'experimental', '{}'::jsonb);
  current jsonb := coalesce(to_jsonb(NEW)->'experimental', '{}'::jsonb);
BEGIN
  IF jsonb_build_array(coalesce(previous->'enablePublicMcp', 'false'::jsonb), coalesce(previous->'enableChatConnectors', 'false'::jsonb))
    IS DISTINCT FROM jsonb_build_array(coalesce(current->'enablePublicMcp', 'false'::jsonb), coalesce(current->'enableChatConnectors', 'false'::jsonb)) THEN
    FOR company IN SELECT DISTINCT company_id FROM agents ORDER BY company_id LOOP
      PERFORM paperclip_invalidate_company_agent_runtimes(company);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_connector_flags_runtime_changed ON instance_settings;
CREATE TRIGGER paperclip_connector_flags_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON instance_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_connector_flags_runtime_changed();
