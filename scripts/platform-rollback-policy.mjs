// Evidence is produced by the real mixed-version check; manual review remains
// a fallback for historical boundary releases.
export function rollbackPolicy(manifest, review, evidence) {
  if (evidence !== undefined) {
    const previous = evidence?.previousRelease;
    const expected = ['previous-startup', 'previous-create-start-complete-cancel', 'candidate-expand-startup', 'previous-startup-after-expand', 'previous-create-start-complete-cancel-after-expand'];
    if (evidence?.format !== 1 || evidence.targetRef !== manifest.ref || evidence.dataSchema !== manifest.dataSchema
        || !/^[a-f0-9]{40}$/.test(previous?.ref ?? '') || !/^[a-f0-9]{64}$/.test(previous?.dataSchema ?? '')
        || !/^\d+\.\d+\.\d+$/.test(previous?.version ?? '')
        || evidence.schema?.contractLevel !== 0 || !Number.isSafeInteger(evidence.schema?.expandLevel) || evidence.schema.expandLevel < 1
        || JSON.stringify(evidence.checks) !== JSON.stringify(expected)
        || JSON.stringify(evidence.rollbackSafeFrom) !== JSON.stringify([previous.dataSchema])) {
      throw new Error('Invalid mixed-version rollback evidence: target SHA/schema, previous published release and completed core probes must match');
    }
    // Reuse the stable-version ordering validation below.
    return rollbackPolicy(manifest, { targetRef: manifest.ref, previousVersion: previous.version,
      previousDataSchema: previous.dataSchema, previousRelease: previous,
      reviewedBy: 'mixed-version PostgreSQL CI', reason: 'Previous release core probes passed on candidate expanded schema' });
  }
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
