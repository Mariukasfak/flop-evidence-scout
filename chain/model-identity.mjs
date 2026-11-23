/**
 * Registry identity of a model, resolved from finalized chain state.
 *
 * The SDK resolves this inside its direct-session runtime but does not export the
 * resolver (0.9.0), and LongSession needs the result as `modelIdentity`. Same rules
 * as the SDK: exactly one Verified registry entry matching the slug, exactly one
 * allowed decode policy, a measured root for the precision. Anything ambiguous is
 * refused rather than guessed, because a wrong identity is a wrong purchase.
 */
import { computeChannel } from '@flop-labs/sdk';

export const PRECISIONS = ['FP32', 'FP16', 'BF16', 'INT8', 'INT4', 'Mixed'];
const u8 = (v) => v.toU8a(true);
const tail = (s) => s.split('/').pop().toLowerCase();

export async function resolveModelIdentity(api, model, backendModelName) {
  const at = await api.at(await api.rpc.chain.getFinalizedHead());
  const reg = at.query.modelRegistry;
  const found = [];
  for (const [key, raw] of await reg.models.entries()) {
    if (!raw.isSome) continue;
    const e = raw.unwrap();
    const name = e.modelName.toHuman();
    if (name.toLowerCase() !== model.toLowerCase() && tail(name) !== tail(model)) continue;
    if (e.status.toString() !== 'Verified') continue;
    const modelHash = u8(key.args[0]);
    const pol = await reg.allowedDecodePolicies(modelHash);
    if (!pol.isSome || pol.unwrap().length !== 1) continue;
    const decodePolicyHash = u8(pol.unwrap()[0]);
    for (const p of e.supportedPrecisions) {
      const precision = computeChannel.modelPrecisionCode(p.toString());
      const root = await reg.measuredRoots(modelHash, PRECISIONS[precision]);
      if (!root.isSome) continue;
      found.push({
        requestedSlug: model, registryModel: name, registryVersion: e.version.toHuman(),
        modelHash, measuredRoot: u8(root.unwrap()), decodePolicyHash, precision, backendModelName
      });
    }
  }
  if (found.length !== 1) throw new Error(`model ${model} resolves to ${found.length} verified identities, need exactly one`);
  return found[0];
}
