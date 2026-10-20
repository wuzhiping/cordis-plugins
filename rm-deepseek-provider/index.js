/**
 * rm-deepseek-provider — keep the DeepSeek LLM routes out of every model
 * surface.
 *
 * The work is done by `cordis.patch.yml`: it disables the two rows that
 * register `deepseek-official` (the API-key route) and `deepseek-account`
 * (the signed-in account route). A disabled row never activates, so its
 * adapter never registers, and both model surfaces — Settings → Models and
 * the composer / `/model` catalog — are built from that same live registry.
 *
 * This Host half writes nothing. It only checks the composed registry once it
 * settles and logs whether the routes are actually gone, so a later patch layer
 * that re-enables a row is visible in the log instead of silently putting the
 * picker entries back.
 *
 * @module rm-deepseek-provider
 */

export const name = 'rm-deepseek-provider';

/** The LLM service whose registry this bundle keeps the routes out of. */
export const inject = ['llm'];

/** Provider route ids this bundle removes. */
export const REMOVED_PROVIDERS = Object.freeze(['deepseek-official', 'deepseek-account']);

/**
 * Report whether any removed route is still registered.
 *
 * @param ctx - the plugin's Context, carrying `llm` through {@link inject}.
 */
function assertRemoved(ctx) {
  const present = ctx.llm
    .listProviders()
    .map((provider) => provider.id)
    .filter((id) => REMOVED_PROVIDERS.includes(id));

  if (present.length === 0) {
    ctx.logger.info(
      'rm-deepseek-provider: DeepSeek LLM routes are not in the model catalog (%s)',
      REMOVED_PROVIDERS.join(', '),
    );
    return;
  }

  ctx.logger.error(
    'rm-deepseek-provider: DeepSeek LLM route(s) are still registered: %s; a later patch layer (or the profile cordis.patch.yml) re-enabled the row this bundle disables',
    present.join(', '),
  );
}

export function apply(ctx) {
  ctx.effect(() => {
    assertRemoved(ctx);
    return ctx.on('llm/adapters-updated', () => assertRemoved(ctx));
  });
}
