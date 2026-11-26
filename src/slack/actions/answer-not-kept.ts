/**
 * #1474 — the follow-up queue did not keep an answer to the model's question (it was full, its store failed, or it
 * could not be read). Thrown out of `SlackHandler.handleMessage` for a `questionAnswer` message only — any other
 * message that is not kept ends with the thread told so. The answer handler took the question off the session when
 * it took the answer; this error is how it learns the answer went nowhere and gives the question back
 * (`ChoiceActionHandler.answerQuestion`).
 */
export class AnswerNotKeptError extends Error {
  constructor(readonly reason: string) {
    super(`The follow-up queue did not keep the answer (${reason})`);
    this.name = 'AnswerNotKeptError';
  }
}
