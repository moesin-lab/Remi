import type {
  CreateMemberRequest,
  Invitation,
  MemberWithUser,
  UpdateMemberRequest,
} from "../../types";
import type { HttpClient } from "../http";
import { parseStrictResponse } from "../schema";
import { WorkspaceMemberSchema } from "../schemas/workspaces";

export class MembersEndpoints {
  constructor(readonly http: HttpClient) {}

  // Members
  async listMembers(workspaceId: string, includeHistory = false): Promise<MemberWithUser[]> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/members${includeHistory ? "?include_history=true" : ""}`);
    return parseStrictResponse(raw, WorkspaceMemberSchema.array(), { endpoint: "GET /api/workspaces/:id/members" });
  }

  async createMember(workspaceId: string, data: CreateMemberRequest): Promise<Invitation> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateMember(workspaceId: string, memberId: string, data: UpdateMemberRequest): Promise<MemberWithUser> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/members/${memberId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteMember(workspaceId: string, memberId: string): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}/members/${memberId}`, {
      method: "DELETE",
    });
  }

  async leaveWorkspace(workspaceId: string): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}/leave`, {
      method: "POST",
    });
  }
}
