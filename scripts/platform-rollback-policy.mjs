// This attestation is supplied by the release manager, never inferred from Git.
export function rollbackPolicy(manifest, review) {
  if (review === undefined) return [];
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const previous = review?.previousRelease;
  if (!review || review.targetRef !== manifest.ref || !text(review.reason) || !text(review.reviewedBy)
      || !/^\d+\.\d+\.\d+$/.test(review.previousVersion) || review.previousVersion === manifest.version
      || previous?.version !== review.previousVersion || !hash(review.previousDataSchema)
      || previous?.dataSchema !== review.previousDataSchema) {
    throw new Error('Invalid reviewed rollback declaration: bind targetRef, previous published version/schema, reason and reviewedBy');
  }
  const version = value => value.split('.').map(Number);
  const targetVersion = version(manifest.version), previousVersion = version(review.previousVersion);
  const difference = targetVersion.map((value, index) => value - previousVersion[index]).find(value => value !== 0);
  if (!(difference > 0)) throw new Error('Rollback declaration must refer to an earlier published version');
  return [review.previousDataSchema];
}
