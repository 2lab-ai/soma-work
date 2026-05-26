import type { SkillStore } from './catalog';
export declare class SkillFileStore implements SkillStore {
  private readonly dataDir;
  constructor(dataDir: string);
  private skillsDir;
  private skillPath;
  listSkills(user: string): Array<{
    name: string;
    description: string;
  }>;
  createSkill(
    user: string,
    name: string,
    content: string,
  ): {
    ok: boolean;
    message: string;
  };
  updateSkill(
    user: string,
    name: string,
    content: string,
  ): {
    ok: boolean;
    message: string;
  };
  deleteSkill(
    user: string,
    name: string,
  ): {
    ok: boolean;
    message: string;
  };
}
//# sourceMappingURL=skill-file-store.d.ts.map
