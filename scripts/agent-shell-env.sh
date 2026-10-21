# Sourced by non-interactive bash through BASH_ENV (docker/docker-compose.release-bot.yml).
# Re-adds the Jest worker cap preload to NODE_OPTIONS in agent shells. The Claude
# Agent SDK deletes NODE_OPTIONS from the environment it gives the Claude process,
# so the Bash tool's `bash -c` shell never inherits it, but it does read BASH_ENV.
# Idempotent. See scripts/jest-worker-cap.cjs.
_paperclip_jest_cap="--require /usr/local/lib/paperclip/jest-worker-cap.cjs"
if [ -r /usr/local/lib/paperclip/jest-worker-cap.cjs ]; then
  case " ${NODE_OPTIONS-} " in
    *" $_paperclip_jest_cap "*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$_paperclip_jest_cap" ;;
  esac
fi
unset _paperclip_jest_cap
