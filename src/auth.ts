import type { SlackClient } from "./slack";

export interface OwnerCheckResult {
  ok: boolean;
  user: string;
  team: string;
  userId: string;
  isOwner: boolean;
  isPrimaryOwner: boolean;
}

/**
 * Verify the configured Slack token belongs to a workspace Owner or Primary Owner.
 * Per the user story, only owners may archive. We enforce this at the token level
 * since this is a self-hosted tool — whoever runs it must hold owner credentials.
 */
export async function verifyOwner(slack: SlackClient): Promise<OwnerCheckResult> {
  const auth = await slack.authTest();
  const { isOwner, isPrimaryOwner } = await slack.isOwner(auth.user_id);
  return {
    ok: isOwner || isPrimaryOwner,
    user: auth.user,
    team: auth.team,
    userId: auth.user_id,
    isOwner,
    isPrimaryOwner,
  };
}
