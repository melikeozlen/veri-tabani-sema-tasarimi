export type GranteeType = 'user' | 'team';

export interface SheetUser {
  username: string;
  passwordHash: string;
  isSuperAdmin: boolean;
  active: boolean;
}

export interface SheetTeam {
  teamId: string;
  teamName: string;
}

export interface SheetTeamMember {
  teamId: string;
  username: string;
}

export interface SheetFolder {
  folderId: string;
  label: string;
  driveFolderId: string;
}

export interface SheetPermission {
  folderId: string;
  granteeType: GranteeType;
  granteeId: string;
}

export interface AuthUser {
  username: string;
  isSuperAdmin: boolean;
}

export interface DriveSourceMeta {
  id: string;
  name: string;
  folderId: string;
  folderLabel: string;
}

export interface DriveSourceContent extends DriveSourceMeta {
  content: string;
}
