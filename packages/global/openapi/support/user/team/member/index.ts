import type { OpenAPIPath } from '../../../../type';
import { DevApiTagsMap } from '../../../../tag';
import {
  CreateTeamMemberBodySchema,
  CreateTeamMemberResponseSchema,
  DeleteTeamMemberQuerySchema,
  ExportTeamMembersResponseSchema,
  GetTeamMemberCountResponseSchema,
  ListTeamMembersBodySchema,
  ListTeamMembersResponseSchema,
  ResetTeamMemberPasswordBodySchema,
  RestoreTeamMemberBodySchema,
  UpdateTeamMemberInviteBodySchema,
  UpdateTeamMemberNameBodySchema,
  UpdateTeamMemberNameByManagerBodySchema
} from './api';

const TeamMemberTags = [DevApiTagsMap.teamMember];

export const TeamMemberPath: OpenAPIPath = {
  '/proApi/support/user/team/member/create': {
    post: {
      summary: '创建团队成员账号',
      description:
        '管理员直接创建用户账号并加入当前团队。开源版用于替代邀请链接流程；配置商业版时转发给商业版',
      tags: [...TeamMemberTags],
      requestBody: {
        content: {
          'application/json': {
            schema: CreateTeamMemberBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '成员账号创建成功',
          content: {
            'application/json': {
              schema: CreateTeamMemberResponseSchema
            }
          }
        }
      }
    }
  },
  '/proApi/support/user/team/member/resetPassword': {
    put: {
      summary: '重置团队成员密码',
      description: '管理员重置指定团队成员的登录密码，并强制该用户全部会话下线',
      tags: [...TeamMemberTags],
      requestBody: {
        content: {
          'application/json': {
            schema: ResetTeamMemberPasswordBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '密码重置成功'
        }
      }
    }
  },
  '/proApi/support/user/team/member/count': {
    get: {
      summary: '获取团队成员数量',
      description: '获取当前团队未离开及未停用的成员数量',
      tags: [...TeamMemberTags],
      responses: {
        200: {
          description: '成功返回团队成员数量',
          content: {
            'application/json': {
              schema: GetTeamMemberCountResponseSchema
            }
          }
        }
      }
    }
  },
  '/proApi/support/user/team/member/delete': {
    delete: {
      summary: '删除团队成员',
      description: '将指定团队成员移出当前团队',
      tags: [...TeamMemberTags],
      requestParams: {
        query: DeleteTeamMemberQuerySchema
      },
      responses: {
        200: {
          description: '团队成员删除成功'
        }
      }
    }
  },
  '/proApi/support/user/team/member/export': {
    get: {
      summary: '导出团队成员',
      description: '将当前团队成员信息导出为 CSV 文件',
      tags: [...TeamMemberTags],
      responses: {
        200: {
          description: '成功导出团队成员 CSV 文件',
          content: {
            'text/csv': {
              schema: ExportTeamMembersResponseSchema
            }
          }
        }
      }
    }
  },
  '/proApi/support/user/team/member/leave': {
    delete: {
      summary: '离开团队',
      description: '当前用户主动离开当前团队，团队所有者不能执行此操作',
      tags: [...TeamMemberTags],
      responses: {
        200: {
          description: '离开团队成功'
        }
      }
    }
  },
  '/proApi/support/user/team/member/list': {
    post: {
      summary: '获取团队成员列表',
      description:
        '分页获取当前团队成员，支持状态、关键词、组织、成员组和指定成员 ID 筛选，可将当前登录成员置顶',
      tags: [...TeamMemberTags],
      requestBody: {
        content: {
          'application/json': {
            schema: ListTeamMembersBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '成功返回团队成员列表',
          content: {
            'application/json': {
              schema: ListTeamMembersResponseSchema
            }
          }
        }
      }
    }
  },
  '/proApi/support/user/team/member/restore': {
    post: {
      summary: '恢复团队成员',
      description: '将指定团队成员状态恢复为 active',
      tags: [...TeamMemberTags],
      requestBody: {
        content: {
          'application/json': {
            schema: RestoreTeamMemberBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '团队成员恢复成功'
        }
      }
    }
  },
  '/proApi/support/user/team/member/updateInvite': {
    put: {
      summary: '更新团队成员邀请状态',
      description: '当前用户更新自己的团队成员邀请状态',
      tags: [...TeamMemberTags],
      requestBody: {
        content: {
          'application/json': {
            schema: UpdateTeamMemberInviteBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '团队成员邀请状态更新成功'
        }
      }
    }
  },
  '/proApi/support/user/team/member/updateName': {
    put: {
      summary: '更新当前用户成员名称',
      description: '当前用户更新自己在当前团队中的成员名称',
      tags: [...TeamMemberTags],
      requestBody: {
        content: {
          'application/json': {
            schema: UpdateTeamMemberNameBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '成员名称更新成功'
        }
      }
    }
  },
  '/proApi/support/user/team/member/updateNameByManager': {
    put: {
      summary: '管理员更新团队成员名称',
      description: '团队管理员更新指定团队成员的名称',
      tags: [...TeamMemberTags],
      requestBody: {
        content: {
          'application/json': {
            schema: UpdateTeamMemberNameByManagerBodySchema
          }
        }
      },
      responses: {
        200: {
          description: '成员名称更新成功'
        }
      }
    }
  }
};
