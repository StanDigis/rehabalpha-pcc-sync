import type { Demographics, PersonLinkMethod } from '../domain/person.js';

/**
 * Deciding whether a PCC patient record is a person RehabAlpha already knows.
 *
 * This matters because PCC patient ids are scoped to an organisation, and the briefing's own
 * scenario produces the hard case: Betty is discharged, goes home, falls again and is
 * readmitted — possibly to a different facility the same therapy company serves. Her prior
 * therapy history and her prior coverage are exactly what the therapist needs, and both are
 * attached to the person rather than to the admission.
 *
 * The governing decision is that nothing probabilistic is ever linked automatically. A wrong
 * merge attaches one person's plan of care and payer to another; it is discovered late, it is
 * a reportable incident, and unpicking a merged chart is far harder than confirming a match
 * once. So there are exactly two automatic paths — an authoritative answer from PCC, or exact
 * agreement on the facility's own unique key — and everything else goes to a human with the
 * evidence laid out.
 */

const REVIEW_THRESHOLD = 0.55;

function normalise(value: string | null): string {
  if (value === null) return '';
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * Jaro-Winkler similarity, the standard choice for personal names: it rewards agreement in
 * the leading characters, which matches how names are actually mistyped and how diminutives
 * behave ("Betty" against "Bettye"), and it is far less punishing than edit distance on
 * transpositions ("Stephen" against "Stpehen").
 */
export function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatched = new Array<boolean>(left.length).fill(false);
  const rightMatched = new Array<boolean>(right.length).fill(false);

  let matches = 0;
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, right.length);
    for (let j = start; j < end; j += 1) {
      if (rightMatched[j] === true) continue;
      if (left[i] !== right[j]) continue;
      leftMatched[i] = true;
      rightMatched[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (leftMatched[i] !== true) continue;
    while (rightMatched[k] !== true) k += 1;
    if (left[i] !== right[k]) transpositions += 1;
    k += 1;
  }

  const halfTranspositions = transpositions / 2;
  const jaro =
    (matches / left.length + matches / right.length + (matches - halfTranspositions) / matches) / 3;

  let commonPrefix = 0;
  while (commonPrefix < 4 && left[commonPrefix] === right[commonPrefix]) {
    commonPrefix += 1;
  }

  return jaro + commonPrefix * 0.1 * (1 - jaro);
}

export type MatchSignals = {
  birthDateMatches: boolean;
  /** Both records state a birth date and they disagree. Distinct from "one of them is missing". */
  birthDateConflicts: boolean;
  lastNameMatches: boolean;
  firstNameSimilarity: number;
  medicalRecordNumberMatches: boolean;
  sharesFacility: boolean;
};

export type IdentityCandidate = {
  personId: string;
  demographics: Demographics;
  /** Facilities this person has already been seen at, within this tenant. */
  facilityIds: readonly string[];
};

export type ScoredCandidate = {
  personId: string;
  score: number;
  signals: MatchSignals;
};

export function scoreCandidate(
  subject: { demographics: Demographics; facilityId: string },
  candidate: IdentityCandidate,
): ScoredCandidate {
  const subjectDemographics = subject.demographics;
  const candidateDemographics = candidate.demographics;

  const bothHaveBirthDate =
    subjectDemographics.birthDate !== null && candidateDemographics.birthDate !== null;
  const birthDateMatches =
    bothHaveBirthDate && subjectDemographics.birthDate === candidateDemographics.birthDate;

  const sharesFacility = candidate.facilityIds.includes(subject.facilityId);
  const bothHaveMrn =
    subjectDemographics.medicalRecordNumber !== null &&
    candidateDemographics.medicalRecordNumber !== null;
  // A medical record number is assigned by the facility, so it only identifies within one.
  // Comparing MRNs across facilities is how two unrelated people get merged.
  const medicalRecordNumberMatches =
    sharesFacility &&
    bothHaveMrn &&
    subjectDemographics.medicalRecordNumber === candidateDemographics.medicalRecordNumber;

  const lastNameMatches =
    normalise(subjectDemographics.lastName) === normalise(candidateDemographics.lastName);
  const firstNameSimilarity = jaroWinkler(
    normalise(subjectDemographics.firstName),
    normalise(candidateDemographics.firstName),
  );

  const signals: MatchSignals = {
    birthDateMatches,
    birthDateConflicts: bothHaveBirthDate && !birthDateMatches,
    lastNameMatches,
    firstNameSimilarity,
    medicalRecordNumberMatches,
    sharesFacility,
  };

  // A confirmed difference in date of birth is close to conclusive evidence of two different
  // people, so it caps the score below the review threshold instead of merely subtracting from
  // it. Without the cap, an identical common name plus a shared facility scores high enough to
  // reach a reviewer, and reviewers approve plausible-looking matches.
  if (bothHaveBirthDate && !birthDateMatches) {
    return { personId: candidate.personId, score: 0.1, signals };
  }

  let score = 0;
  if (birthDateMatches) score += 0.45;
  if (medicalRecordNumberMatches) score += 0.3;
  score +=
    (lastNameMatches
      ? 1
      : jaroWinkler(
          normalise(subjectDemographics.lastName),
          normalise(candidateDemographics.lastName),
        )) * 0.25;
  score += firstNameSimilarity * 0.2;
  if (sharesFacility) score += 0.05;

  return { personId: candidate.personId, score: Math.min(1, score), signals };
}

export type AuthoritativeMatch = {
  personId: string;
  method: Extract<PersonLinkMethod, 'pccMasterPatient' | 'pccMatchApi'>;
};

export type IdentityOutcome =
  | { decision: 'link'; personId: string; method: PersonLinkMethod; confidence: number }
  | { decision: 'createPerson' }
  | { decision: 'review'; candidates: ScoredCandidate[] };

export type ResolveIdentityInput = {
  subject: { demographics: Demographics; facilityId: string };
  candidates: readonly IdentityCandidate[];
  /**
   * PCC's own answer, from the organisation master patient record or the patient match
   * endpoint. When present it wins outright: PCC is the source of truth for identity within
   * its organisation, and it has evidence we do not.
   */
  authoritative?: AuthoritativeMatch | null;
};

export function resolveIdentity({
  subject,
  candidates,
  authoritative = null,
}: ResolveIdentityInput): IdentityOutcome {
  if (authoritative !== null) {
    return {
      decision: 'link',
      personId: authoritative.personId,
      method: authoritative.method,
      confidence: 1,
    };
  }

  const scored = candidates
    .map((candidate) => scoreCandidate(subject, candidate))
    .sort((a, b) => b.score - a.score);

  const mrnMatches = scored.filter((candidate) => candidate.signals.medicalRecordNumberMatches);

  // Same facility, same medical record number, different date of birth. One of the two records is
  // wrong and there is no way to tell which from here, so this is the one case where a deterministic
  // key is not honoured: it goes to a human with the conflict named. Linking would merge two charts
  // on the strength of a key that the demographics contradict.
  const conflicted = mrnMatches.filter((candidate) => candidate.signals.birthDateConflicts);
  const clean = mrnMatches.find((candidate) => !candidate.signals.birthDateConflicts);

  if (clean !== undefined) {
    return {
      decision: 'link',
      personId: clean.personId,
      method: 'deterministicLocal',
      confidence: 1,
    };
  }

  const reviewable = scored.filter((candidate) => candidate.score >= REVIEW_THRESHOLD);
  const forReview = [...conflicted, ...reviewable.filter((row) => !conflicted.includes(row))];

  if (forReview.length === 0) {
    return { decision: 'createPerson' };
  }

  return { decision: 'review', candidates: forReview.slice(0, 5) };
}
