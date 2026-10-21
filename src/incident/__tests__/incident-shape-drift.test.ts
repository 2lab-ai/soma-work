/**
 * The incident request and trust anchor are declared once, in
 * `packages/slack/src/incident-contract.ts`, and MIRRORED in three root-`src/`
 * places that cannot import it: root `src/` resolves `@soma/slack/*` through the
 * workspace symlink to the package's compiled `dist/` (see the note on
 * `SessionIncidentRequest` in `src/types.ts`).
 *
 * A mirror that drifts is a field the parser validates and the runtime never
 * reads, or the reverse. These assertions are type-level: `npx tsc --noEmit`
 * type-checks this file (the root tsconfig includes `src/**`) and fails on any
 * difference — an added, dropped, renamed, retyped or no-longer-readonly field.
 * The vitest run itself only proves the file loads.
 *
 * (The pipeline session's `incidentRequest` already imports the contract type
 * directly — `packages/slack/src/pipeline/types.ts:1` — so it has no mirror.)
 */

import type { IncidentRequest, TrustedIncidentSource } from '@soma/slack/incident-contract';
import { describe, expectTypeOf, it } from 'vitest';
import type { IncidentTrustedSource } from '../../config';
import type { SessionIncidentRequest } from '../../types';
import type { IncidentRequestLike } from '../sdk-options';

describe('incident request/trust mirrors match the contract', () => {
  it('the session copy of the request is the contract request', () => {
    expectTypeOf<SessionIncidentRequest>().toEqualTypeOf<IncidentRequest>();
  });

  it('the runtime adapter view of the request is the contract request', () => {
    expectTypeOf<IncidentRequestLike>().toEqualTypeOf<IncidentRequest>();
  });

  it('the config trust anchor is the contract trust anchor', () => {
    expectTypeOf<IncidentTrustedSource>().toEqualTypeOf<TrustedIncidentSource>();
  });
});
