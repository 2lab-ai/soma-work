# AI Agent 기반 프로젝트 문서 정리 리서치

> 작성일: 2026-05-18
> 목적: AI coding agent가 프로젝트를 반복적으로 이해하고 안전하게 이어받을 수 있도록 루트와 `docs/` 문서를 정리하는 기준을 세운다.

## 요약

최근 에이전트 도구 문서는 공통적으로 "짧은 영구 지시문 + 구조화된 프로젝트 문서 + 실행 흔적/결정 로그 분리"를 권장한다. 이 repo에는 이미 `CLAUDE.md`, `AGENTS.md`, `docs/current/spec/`, feature별 `spec.md`/`trace.md`, `docs/archive/`가 있으므로 새 구조를 발명하기보다 라우팅 문서와 상태 원장을 추가하는 편이 안전하다.

## 확인한 자료

- OpenAI Codex Customization: `AGENTS.md`, memories, skills, MCP, subagents는 경쟁 관계가 아니라 역할이 다른 레이어다. `AGENTS.md`는 작게 유지하고 반복되는 실수, repo 규칙, 빌드/테스트 명령을 담는 것이 적합하다. <https://developers.openai.com/codex/concepts/customization>
- OpenAI Codex AGENTS.md: repo root와 nested directory instruction을 계층화하고, 필요하면 fallback filename과 byte limit을 설정한다. Codex는 instruction source 확인 명령과 로그로 로딩 상태를 검증할 수 있다. <https://developers.openai.com/codex/guides/agents-md>
- OpenAI Codex Worktrees: worktree는 같은 Git repo에서 독립 checkout을 만들어 병렬 작업이 서로 간섭하지 않게 한다. 문서 정리도 현재 local checkout을 더럽히지 않기 위해 worktree에서 진행하는 것이 맞다. <https://developers.openai.com/codex/app/worktrees>
- Anthropic Claude Code Memory: `CLAUDE.md`는 프로젝트 지시와 팀 규칙, auto memory는 반복 작업에서 생긴 학습을 담는다. 짧고 구체적이며 구조화된 지시가 더 잘 따른다. <https://code.claude.com/docs/en/memory>
- Anthropic Help Center: `CLAUDE.md`에는 명령, 규칙, 짧은 아키텍처, hard constraint, known gotcha가 맞고, changelog/history/API 전체 문서는 적합하지 않다. <https://support.claude.com/en/articles/14553240-give-claude-context-claude-md-and-better-prompts>
- OpenAI Agents SDK Tracing: agent run은 LLM generation, tool call, handoff, guardrail, custom event를 trace/span으로 남길 수 있다. 이 repo의 `trace.md`는 이 원칙을 문서 파일로 구현한 형태다. <https://openai.github.io/openai-agents-js/guides/tracing/>
- Google ADK Artifacts: 큰 산출물, 보고서, 중간 결과, versioned/generated output은 session state와 분리된 artifact로 다루는 것이 맞다. 이 repo에서는 `docs/misc/research/`, `docs/archive/`, feature `trace.md`가 artifact에 가까운 역할을 한다. <https://adk.dev/artifacts/>
- arXiv 2601.20404: AGENTS.md가 있는 조건에서 agent runtime과 output token이 줄어드는 경향을 보고했다. 아직 arXiv 연구이므로 repo 정책의 보조 근거로만 사용한다. <https://arxiv.org/abs/2601.20404>
- arXiv 2605.14563: repository-level documentation은 dependency-aware traversal과 shared memory를 결합할 때 중복/충돌을 줄인다고 제안한다. 2026-05-14 공개 논문이므로 최신 연구 신호로만 참고한다. <https://arxiv.org/abs/2605.14563>

## 적용 원칙

1. `CLAUDE.md`/`AGENTS.md`는 에이전트 행동 지시만 담는다. 완료 이력, 긴 changelog, 전체 API 설명은 `docs/`로 보낸다.
2. 루트 `README.md`/`README.ko.md`는 제품 소개와 빠른 진입점만 맡는다.
3. `docs/README.md`를 docs 라우터로 둔다. 새 에이전트는 이 파일에서 현재 문서, 스펙, trace, ADR, archive 위치를 찾는다.
4. 기능 작업은 `docs/<feature>/spec.md`와 `docs/<feature>/trace.md`를 유지한다. `spec.md`는 의도, `trace.md`는 실제 실행 증거다.
5. 완료/폐기/과거 참고 문서는 삭제보다 `docs/archive/`로 이동한다. 단, 명확한 완료 증거가 없으면 이동하지 않는다.
6. ADR은 되돌리기 어렵거나 cross-cutting한 결정만 별도 파일로 만든다. 작은 구현 중 선택은 기존 `Auto-Decisions` 표에 남긴다.
7. 완료 상태는 별도 원장인 `docs/archive/completed-work.md`에서 링크와 증거 중심으로 관리한다.
8. 리서치는 날짜 prefix를 붙여 `docs/misc/research/`에 남긴다. 최신성 의존성이 큰 내용은 작성일을 명시한다.

## soma-work에 바로 적용한 결론

- 기존 cleanup/gardening pass는 완료 상태가 trace로 확인되므로 `docs/archive/completed-work.md`에 인덱싱한다.
- 현재 feature doc 다수는 완료 여부가 파일명만으로 확정되지 않으므로 대량 이동하지 않는다.
- `docs/adr/`를 추가하되, 기존 `Auto-Decisions`를 한 번에 ADR로 변환하지 않는다. 우선 index를 만들고 cross-cutting 문서 체계 결정 하나만 ADR로 승격한다.
- 루트 문서는 새 docs map으로 연결만 추가한다. 루트에 새 task별 문서를 늘리지 않는다.
