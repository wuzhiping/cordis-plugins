/**
 * aife-provider — the AIFE route's non-secret configuration, owned by this
 * bundle's own patch layer.
 *
 * The ownership mechanism is placement, not policing: `cordis.patch.yml` in
 * this package carries `llm-pi-ai.providers.aife` as a *bundle* layer. The
 * Models settings page computes a row's Delete button as
 *
 * ```js
 * removable = hasPath(namespace.user, path) && !hasPath(namespace.base, path)
 * ```
 *
 * so a route that a bundle layer already provides renders without that button —
 * no refusal dialog, no failed write. The route stays an ordinary settings
 * value, so the API key remains editable: it lives in the credentials service
 * under the `AIFE_API_KEY` reference the patch names, and a key edit writes only
 * that reference into the profile layer while this layer keeps supplying the
 * rest.
 *
 * This Host half therefore writes nothing. Repairing a missing route by writing
 * `providers.aife` into the profile layer would re-create exactly the entry that
 * makes the route removable, so an absent route is reported as an error naming
 * `cordis.patch.yml` instead.
 *
 * @module @local/aife-provider
 */

/** Profile entry id of the pi-ai section this bundle configures. */
const TARGET_ENTRY_ID = 'llm-pi-ai';

/** Provider route key this bundle owns inside `llm-pi-ai.providers`. */
export const MANAGED_PROVIDER = 'aife';

/**
 * The non-secret shape this bundle asserts. Kept beside the patch that carries
 * it so the activation check and the patch cannot drift apart unnoticed.
 */
export const EXPECTED_PROFILE = Object.freeze({
  displayName: 'AIFE',
  api: 'openai-completions',
  baseURL: 'https://routellm.feg.cn/v1',
  apiKeyEnv: 'AIFE_API_KEY',
});

export const name = 'aife-provider';
export const inject = ['settings'];

/** Whether one resolved profile carries every asserted field. */
function carriesExpected(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return false;
  return Object.entries(EXPECTED_PROFILE).every(([field, expected]) => profile[field] === expected);
}

/**
 * Report whether the route this bundle owns is actually composed.
 *
 * @param ctx - the plugin's Context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const descriptor = ctx.settings.describe().find((row) => row.ns === TARGET_ENTRY_ID);
    if (descriptor === undefined) return () => {};

    const profile = descriptor.value?.providers?.[MANAGED_PROVIDER];
    if (carriesExpected(profile)) {
      ctx.logger.info(
        'aife-provider: this bundle supplies the "%s" route (%s)',
        MANAGED_PROVIDER,
        EXPECTED_PROFILE.baseURL,
      );
    } else {
      ctx.logger.error(
        'aife-provider: %s.providers.%s is missing or degraded; this bundle\'s cordis.patch.yml must supply it',
        TARGET_ENTRY_ID,
        MANAGED_PROVIDER,
      );
    }
    return () => {};
  });
}
