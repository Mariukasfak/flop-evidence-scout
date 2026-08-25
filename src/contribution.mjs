import { signMessageBase64Url, verifyMessage } from './identity.mjs';

/**
 * `technocore-contribution-v1` — the community convention for binding a DID to
 * one exact, immutable revision of a public artifact.
 *
 * Originated in zunmax/technocore-did-starter, which at the time of writing has
 * 81 stars and 72 forks: whatever tooling grows around contribution claims will
 * read this shape, so emitting anything else means not being read. Interop is
 * the whole reason to adopt it — the schema itself is unremarkable.
 *
 * The canonical form must match the reference implementation byte for byte, or
 * signatures will not cross-verify:
 *
 *   json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
 *
 * which is keys in alphabetical order, no whitespace, non-ASCII left raw.
 *
 * A caveat worth carrying with the code: this channel is already being abused.
 * Sampling /r/technocore on 2026-08-25 turned up the same "Public contribution
 * [compatibility_report]" sentence posted by several different DIDs, each
 * pointing at an unrelated third-party GitHub issue. A proof therefore says only
 * "this DID signed this URL" — it is not evidence the artifact is any good, or
 * even that the signer wrote it. The value is entirely in what the URL resolves
 * to.
 */

export const CONTRIBUTION_SCHEMA = 'technocore-contribution-v1';
export const PROOF_SCHEMA = 'technocore-contribution-proof-v1';

const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

export function contributionPayload(artifactUrl, commit) {
  if (typeof artifactUrl !== 'string' || typeof commit !== 'string') {
    throw new Error('artifact URL and commit must be strings');
  }
  if (artifactUrl !== artifactUrl.trim()) {
    throw new Error('artifact URL must not contain surrounding whitespace');
  }

  let parsed;
  try {
    parsed = new URL(artifactUrl);
  } catch {
    throw new Error('artifact URL is malformed');
  }
  if (parsed.protocol !== 'https:') throw new Error('artifact URL must be https');
  if (parsed.hash) throw new Error('artifact URL must not contain a fragment');
  if (parsed.username || parsed.password) {
    throw new Error('artifact URL must not contain embedded credentials');
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error('commit must be a complete 40- or 64-character hexadecimal revision');
  }

  // Keys alphabetical, no spaces — the reference canonicalisation.
  return JSON.stringify({
    artifact_url: artifactUrl,
    commit: commit.toLowerCase(),
    schema: CONTRIBUTION_SCHEMA
  });
}

export function createContributionProof(identity, artifactUrl, commit) {
  if (!identity?.did || !identity?.privateKeyPem) {
    throw new Error('Identity with a private key is required to sign a contribution');
  }
  const payload = contributionPayload(artifactUrl, commit);
  return {
    schema: PROOF_SCHEMA,
    did: identity.did,
    artifact_url: artifactUrl,
    commit: commit.toLowerCase(),
    signature: signMessageBase64Url(payload, identity.privateKeyPem)
  };
}

export function verifyContributionProof(proof) {
  if (proof?.schema !== PROOF_SCHEMA) throw new Error('unsupported contribution proof schema');
  for (const field of ['did', 'artifact_url', 'commit', 'signature']) {
    if (typeof proof[field] !== 'string') {
      throw new Error('contribution proof is missing required string fields');
    }
  }
  const payload = contributionPayload(proof.artifact_url, proof.commit);
  if (!verifyMessage(payload, proof.signature, proof.did)) {
    throw new Error('contribution proof signature does not verify against its DID');
  }
  return true;
}

/**
 * The room line announcing a proof. Kept short and specific: the swarm's version
 * of this is a fixed sentence plus a stranger's issue URL, so anything generic
 * now reads as farming whether or not it is.
 */
export function contributionAnnouncement(proof, { summary }) {
  if (!summary || summary.length < 20) {
    throw new Error('A contribution announcement needs a real one-line summary of the work.');
  }
  return `[contribution ${CONTRIBUTION_SCHEMA}] ${summary} | ${proof.artifact_url} @ ${proof.commit.slice(0, 12)} | signed by ${proof.did}`;
}
