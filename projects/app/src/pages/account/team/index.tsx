'use client';
import AccountContainer from '@/pageComponents/account/AccountContainer';
import { Box, Flex } from '@chakra-ui/react';
import { useClientTranslation } from '@fastgpt/web/i18n/useClientTranslation';
import TeamSelector from '@/pageComponents/account/TeamSelector';
import { useUserStore } from '@/web/support/user/useUserStore';
import React, { useMemo } from 'react';
import { useContextSelector } from 'use-context-selector';
import { useRouter } from 'next/router';
import FillRowTabs from '@fastgpt/web/components/common/Tabs/FillRowTabs';
import MyIcon from '@fastgpt/web/components/common/Icon';
import { TeamMemberRoleEnum } from '@fastgpt/global/support/user/team/constant';
import { DEFAULT_TEAM_AVATAR } from '@fastgpt/global/common/system/constants';
import { TeamContext, TeamModalContextProvider } from '@/pageComponents/account/team/context';
import dynamic from 'next/dynamic';
import { useSystemStore } from '@/web/common/system/useSystemStore';
import { useToast } from '@fastgpt/web/hooks/useToast';
import { accountPageRootStyles, accountTitleTextStyles } from '@/pageComponents/account/styles';

const MemberTable = dynamic(() => import('@/pageComponents/account/team/MemberTable'));
const PermissionManage = dynamic(
  () => import('@/pageComponents/account/team/PermissionManage/index')
);
const AuditLog = dynamic(() => import('@/pageComponents/account/team/Audit/index'));
const GroupManage = dynamic(() => import('@/pageComponents/account/team/GroupManage/index'));
const OrgManage = dynamic(() => import('@/pageComponents/account/team/OrgManage/index'));
const HandleInviteModal = dynamic(
  () => import('@/pageComponents/account/team/Invite/HandleInviteModal')
);

export enum TeamTabEnum {
  member = 'member',
  org = 'org',
  group = 'group',
  permission = 'permission',
  audit = 'audit'
}

const Team = () => {
  const router = useRouter();

  const invitelinkid = useMemo(() => {
    const _id = router.query.invitelinkid;
    if (!_id && typeof _id !== 'string') {
      return '';
    } else {
      return _id as string;
    }
  }, [router.query.invitelinkid]);

  const { teamTab = TeamTabEnum.member } = router.query as { teamTab: `${TeamTabEnum}` };

  const { t } = useClientTranslation(['account', 'account_team', 'user']);
  const { userInfo, teamPlanStatus } = useUserStore();
  const standardPlan = teamPlanStatus?.standard;
  const level = standardPlan?.currentSubLevel;
  const { subPlans, feConfigs } = useSystemStore();
  // 与后端 authSystemAdmin 一致：只有系统管理员能创建团队
  const isRoot = userInfo?.username === 'root';
  const planContent = useMemo(() => {
    const plan = level !== undefined ? subPlans?.standard?.[level] : undefined;
    if (!plan) return;
    return {
      auditLogStoreDuration: plan?.auditLogStoreDuration
    };
  }, [subPlans?.standard, level]);
  const { toast } = useToast();

  const { setEditTeamData, teamSize } = useContextSelector(TeamContext, (v) => v);

  const Tabs = useMemo(
    () => (
      <FillRowTabs
        w={['100%', 'auto']}
        size={'sm'}
        scrollPositionKey={'account-team-tabs'}
        list={[
          { label: t('account_team:member'), value: TeamTabEnum.member },
          // 权限管理与审计日志在开源版已实现，始终显示（审计日志仅管理员可见）；
          // 组织架构/成员组的增删改仍是商业版能力，开源模式下隐藏入口，
          // 避免点进去只看到报错。
          { label: t('account_team:permission'), value: TeamTabEnum.permission },
          ...(userInfo?.team.permission.hasManagePer
            ? [{ label: t('account_team:audit_log'), value: TeamTabEnum.audit }]
            : []),
          ...(feConfigs?.isPlus
            ? [
                { label: t('account_team:org'), value: TeamTabEnum.org },
                { label: t('account_team:group'), value: TeamTabEnum.group }
              ]
            : [])
        ]}
        value={teamTab}
        onChange={(e) => {
          if (e === TeamTabEnum.audit && planContent && !planContent?.auditLogStoreDuration) {
            toast({
              status: 'warning',
              title: t('common:not_permission')
            });
            return;
          }
          router.replace({
            query: {
              ...router.query,
              teamTab: e
            }
          });
        }}
      />
    ),
    [
      feConfigs?.isPlus,
      planContent,
      router,
      t,
      teamTab,
      toast,
      userInfo?.team.permission.hasManagePer
    ]
  );

  return (
    <AccountContainer>
      <Flex {...accountPageRootStyles} flexDirection={'column'}>
        {/* header */}
        <Flex
          w={'100%'}
          h={'64px'}
          flexShrink={0}
          px={6}
          borderBottom={'1px solid'}
          borderColor={'myGray.200'}
          bg={'white'}
          align={'center'}
          justify={'space-between'}
        >
          <Flex align={'center'}>
            <Box as={'h1'} display={['none', 'block']} {...accountTitleTextStyles}>
              {t('account:team')}
            </Box>
            <Flex align={'center'} ml={[0, 6]}>
              <TeamSelector height={'34px'} />
            </Flex>
            {/*
              创建团队：不传 id 即为创建模式（EditInfoModal 按 defaultData.id 区分创建/编辑）。
              仅 root 可见，与后端 authSystemAdmin 校验保持一致。
              商业版把入口放在 TeamSelector 下拉里，这里放在页头，避免改动被多处复用的 TeamSelector。
            */}
            {isRoot && (
              <Flex align={'center'} justify={'center'} ml={2} p={'0.44rem'}>
                <MyIcon
                  name="common/addLight"
                  w="18px"
                  cursor="pointer"
                  _hover={{ color: 'primary.500' }}
                  onClick={() => setEditTeamData({ name: '', avatar: DEFAULT_TEAM_AVATAR })}
                />
              </Flex>
            )}
            {userInfo?.team?.role === TeamMemberRoleEnum.owner && (
              <Flex align={'center'} justify={'center'} ml={2} p={'0.44rem'}>
                <MyIcon
                  name="edit"
                  w="18px"
                  cursor="pointer"
                  _hover={{
                    color: 'primary.500'
                  }}
                  onClick={() => {
                    if (!userInfo?.team) return;
                    setEditTeamData({
                      id: userInfo.team.teamId,
                      name: userInfo.team.teamName,
                      avatar: userInfo.team.teamAvatar ?? undefined,
                      notificationAccount: userInfo.team.notificationAccount ?? undefined
                    });
                  }}
                />
              </Flex>
            )}
          </Flex>

          <Box
            float={'right'}
            color={'myGray.900'}
            h={'1.25rem'}
            px={'0.5rem'}
            py={'0.125rem'}
            fontSize={'0.75rem'}
            borderRadius={'1.25rem'}
            bg={'myGray.150'}
          >
            {t('account_team:total_team_members', { amount: teamSize })}
          </Box>
        </Flex>

        {/* table */}
        <Box
          py={6}
          px={teamTab === TeamTabEnum.org ? 6 : 0}
          flex={['0 0 auto', '1 0 0']}
          display={'flex'}
          flexDirection={'column'}
          overflow={teamTab === TeamTabEnum.org ? ['visible', 'auto'] : ['visible', 'hidden']}
        >
          {teamTab === TeamTabEnum.member && <MemberTable Tabs={Tabs} />}
          {teamTab === TeamTabEnum.org && <OrgManage Tabs={Tabs} />}
          {teamTab === TeamTabEnum.group && <GroupManage Tabs={Tabs} />}
          {teamTab === TeamTabEnum.permission && <PermissionManage Tabs={Tabs} />}
          {teamTab === TeamTabEnum.audit && <AuditLog Tabs={Tabs} />}
        </Box>
      </Flex>
      {invitelinkid && <HandleInviteModal invitelinkid={invitelinkid} />}
    </AccountContainer>
  );
};

const Render = () => {
  const { userInfo } = useUserStore();

  return !!userInfo?.team ? (
    <TeamModalContextProvider>
      <Team />
    </TeamModalContextProvider>
  ) : null;
};

export default React.memo(Render);
