import { describe, expect, it } from 'vitest';
import type { Demographics } from '../domain/person.js';
import { ADMINISTRATIVE_SEX_VALUES } from '../domain/person.js';
import { toOpenEnum } from '../schema-primitives.js';
import {
  jaroWinkler,
  resolveIdentity,
  scoreCandidate,
  type IdentityCandidate,
} from './identity-match.js';

const FERNCREST = 'fac_ferncrest';
const LAKESIDE = 'fac_lakeside';

function demographics(overrides: Partial<Demographics> = {}): Demographics {
  return {
    firstName: 'Betty',
    lastName: 'Alvarez',
    birthDate: '1941-06-12',
    middleName: null,
    preferredName: null,
    administrativeSex: toOpenEnum(ADMINISTRATIVE_SEX_VALUES, 'FEMALE'),
    medicalRecordNumber: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<IdentityCandidate> = {}): IdentityCandidate {
  return {
    personId: 'per_betty',
    demographics: demographics(),
    facilityIds: [FERNCREST],
    ...overrides,
  };
}

function subject(overrides: Partial<Demographics> = {}, facilityId = FERNCREST) {
  return { demographics: demographics(overrides), facilityId };
}

describe('jaroWinkler', () => {
  it('scores identical strings as a perfect match', () => {
    expect(jaroWinkler('betty', 'betty')).toBe(1);
  });

  it('scores a disjoint pair as no match', () => {
    expect(jaroWinkler('betty', '')).toBe(0);
  });

  it('rates a shared prefix highly, which is how diminutives differ', () => {
    expect(jaroWinkler('betty', 'bettye')).toBeGreaterThan(0.9);
  });

  it('tolerates a transposition, which edit distance punishes hard', () => {
    expect(jaroWinkler('stephen', 'stpehen')).toBeGreaterThan(0.9);
  });

  it('keeps unrelated names well apart', () => {
    expect(jaroWinkler('betty', 'harold')).toBeLessThan(0.6);
  });
});

describe('scoreCandidate', () => {
  it('only counts a medical record number as matching within the same facility', () => {
    const sameFacility = scoreCandidate(
      subject({ medicalRecordNumber: 'MRN-77' }, FERNCREST),
      candidate({ demographics: demographics({ medicalRecordNumber: 'MRN-77' }) }),
    );
    const otherFacility = scoreCandidate(
      subject({ medicalRecordNumber: 'MRN-77' }, LAKESIDE),
      candidate({ demographics: demographics({ medicalRecordNumber: 'MRN-77' }) }),
    );

    expect(sameFacility.signals.medicalRecordNumberMatches).toBe(true);
    expect(otherFacility.signals.medicalRecordNumberMatches).toBe(false);
  });

  /**
   * A confirmed difference in date of birth caps the score rather than subtracting from it. Without
   * the cap an identical common name plus a shared facility still clears the review threshold, and
   * a reviewer looking at two Maria Garcias will approve it.
   */
  it('caps the score below the review threshold when birth dates disagree', () => {
    const result = scoreCandidate(
      subject({ birthDate: '1955-01-01' }),
      candidate({ demographics: demographics({ birthDate: '1941-06-12' }) }),
    );

    expect(result.signals.birthDateConflicts).toBe(true);
    expect(result.score).toBeLessThan(0.5);
  });

  it('does not treat a missing birth date on either side as a conflict', () => {
    const result = scoreCandidate(
      subject({ birthDate: null }),
      candidate({ demographics: demographics({ birthDate: '1941-06-12' }) }),
    );

    expect(result.signals.birthDateConflicts).toBe(false);
    expect(result.signals.birthDateMatches).toBe(false);
  });

  it('ignores accents and casing when comparing names', () => {
    const result = scoreCandidate(
      subject({ firstName: 'BETTY', lastName: 'ÁLVAREZ' }),
      candidate(),
    );

    expect(result.signals.lastNameMatches).toBe(true);
    expect(result.signals.firstNameSimilarity).toBe(1);
  });
});

describe('resolveIdentity', () => {
  it('accepts PCC as the source of truth for identity within its organisation', () => {
    const outcome = resolveIdentity({
      subject: subject(),
      candidates: [candidate({ personId: 'per_other' })],
      authoritative: { personId: 'per_master', method: 'pccMasterPatient' },
    });

    expect(outcome).toEqual({
      decision: 'link',
      personId: 'per_master',
      method: 'pccMasterPatient',
      confidence: 1,
    });
  });

  it('links automatically on an exact medical record number within the facility', () => {
    const outcome = resolveIdentity({
      subject: subject({ medicalRecordNumber: 'MRN-77' }),
      candidates: [candidate({ demographics: demographics({ medicalRecordNumber: 'MRN-77' }) })],
    });

    expect(outcome).toMatchObject({
      decision: 'link',
      personId: 'per_betty',
      method: 'deterministicLocal',
    });
  });

  /**
   * The rule the whole policy is built around. A wrong merge attaches one resident's plan of care
   * and payer to another, it is found late, and unpicking a merged chart is far harder than
   * confirming a match once.
   */
  it('never links a probabilistic match, however strong, and routes it to review', () => {
    const outcome = resolveIdentity({
      subject: subject({ firstName: 'Bettye' }),
      candidates: [candidate()],
    });

    expect(outcome.decision).toBe('review');
    if (outcome.decision !== 'review') throw new Error('expected review');
    expect(outcome.candidates[0]).toMatchObject({ personId: 'per_betty' });
    expect(outcome.candidates[0]!.score).toBeGreaterThan(0.55);
  });

  it('creates a new person when nothing comes close', () => {
    const outcome = resolveIdentity({
      subject: subject({ firstName: 'Harold', lastName: 'Whitfield', birthDate: '1933-02-02' }),
      candidates: [candidate()],
    });

    expect(outcome).toEqual({ decision: 'createPerson' });
  });

  it('creates a new person when there are no candidates at all', () => {
    expect(resolveIdentity({ subject: subject(), candidates: [] })).toEqual({
      decision: 'createPerson',
    });
  });

  /**
   * A shared MRN with contradicting demographics means one of the two records is wrong, and the code
   * cannot tell which. This is the one case where a deterministic key is deliberately not honoured.
   */
  it('sends a matching record number with a conflicting birth date to review, not to a link', () => {
    const outcome = resolveIdentity({
      subject: subject({ medicalRecordNumber: 'MRN-77', birthDate: '1955-01-01' }),
      candidates: [
        candidate({
          demographics: demographics({ medicalRecordNumber: 'MRN-77', birthDate: '1941-06-12' }),
        }),
      ],
    });

    expect(outcome.decision).toBe('review');
    if (outcome.decision !== 'review') throw new Error('expected review');
    expect(outcome.candidates[0]!.signals).toMatchObject({
      medicalRecordNumberMatches: true,
      birthDateConflicts: true,
    });
  });

  it('prefers the unconflicted record-number match when both are present', () => {
    const outcome = resolveIdentity({
      subject: subject({ medicalRecordNumber: 'MRN-77' }),
      candidates: [
        candidate({
          personId: 'per_conflicted',
          demographics: demographics({ medicalRecordNumber: 'MRN-77', birthDate: '1900-01-01' }),
        }),
        candidate({
          personId: 'per_clean',
          demographics: demographics({ medicalRecordNumber: 'MRN-77' }),
        }),
      ],
    });

    expect(outcome).toMatchObject({ decision: 'link', personId: 'per_clean' });
  });

  it('orders review candidates by score and caps the list', () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate({
        personId: `per_${index}`,
        demographics: demographics({ firstName: index === 3 ? 'Betty' : 'Bettye' }),
      }),
    );

    const outcome = resolveIdentity({ subject: subject(), candidates });

    expect(outcome.decision).toBe('review');
    if (outcome.decision !== 'review') throw new Error('expected review');
    expect(outcome.candidates).toHaveLength(5);
    expect(outcome.candidates[0]!.personId).toBe('per_3');
  });

  /**
   * Betty's readmission to a different facility of the same therapy company is the scenario from the
   * brief. Her therapy history hangs off the person record, so failing to surface the match is what
   * loses it — but a different facility means no shared MRN, so it has to be a review rather than a
   * link.
   */
  it('surfaces a readmission at a sister facility for review', () => {
    const outcome = resolveIdentity({
      subject: subject({}, LAKESIDE),
      candidates: [candidate({ facilityIds: [FERNCREST] })],
    });

    expect(outcome.decision).toBe('review');
    if (outcome.decision !== 'review') throw new Error('expected review');
    expect(outcome.candidates[0]!.signals.sharesFacility).toBe(false);
  });
});
