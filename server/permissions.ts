import { loadFolders, loadPermissions, loadTeamMembers } from './sheet.js';
import type { AuthUser, SheetFolder } from './types.js';

export async function getAllowedFolders(user: AuthUser): Promise<SheetFolder[]> {
  const folders = await loadFolders();
  if (user.isSuperAdmin) return folders;

  const [members, permissions] = await Promise.all([loadTeamMembers(), loadPermissions()]);
  const teamIds = new Set(
    members.filter((member) => member.username === user.username).map((member) => member.teamId),
  );

  const allowedFolderIds = new Set<string>();
  for (const permission of permissions) {
    if (permission.granteeType === 'user' && permission.granteeId === user.username) {
      allowedFolderIds.add(permission.folderId);
      continue;
    }
    if (permission.granteeType === 'team' && teamIds.has(permission.granteeId)) {
      allowedFolderIds.add(permission.folderId);
    }
  }

  return folders.filter((folder) => allowedFolderIds.has(folder.folderId));
}
