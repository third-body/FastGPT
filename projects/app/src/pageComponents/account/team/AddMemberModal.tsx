import React from 'react';
import { useForm } from 'react-hook-form';
import { useClientTranslation } from '@fastgpt/web/i18n/useClientTranslation';
import { useRequest } from '@fastgpt/web/hooks/useRequest';
import MyModal from '@fastgpt/web/components/v2/common/MyModal';
import { Box, Button, Flex, Input, ModalBody, ModalFooter } from '@chakra-ui/react';
import { postCreateMember } from '@/web/support/user/team/api';

type AddMemberFormType = {
  username: string;
  password: string;
  confirmPassword: string;
  memberName: string;
};

/**
 * 开源版「管理员建号」弹窗。
 *
 * 商业版走邀请链接让对方自助注册，开源版没有邮箱/短信通道，
 * 改由管理员直接设定用户名和初始密码，线下告知成员即可登录。
 */
function AddMemberModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { t } = useClientTranslation(['account_team', 'user']);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors }
  } = useForm<AddMemberFormType>({
    defaultValues: { username: '', password: '', confirmPassword: '', memberName: '' }
  });

  const { runAsync: onCreate, loading } = useRequest(
    async (data: AddMemberFormType) =>
      postCreateMember({
        username: data.username.trim(),
        password: data.password,
        memberName: data.memberName.trim() || undefined
      }),
    {
      onSuccess() {
        onSuccess();
        onClose();
      },
      successToast: t('common:create_success'),
      errorToast: t('common:create_failed')
    }
  );

  return (
    <MyModal isOpen onClose={onClose} title={t('account_team:add_member')} w={'32rem'}>
      <ModalBody>
        <Flex flexDirection={'column'} gap={4}>
          <Box>
            <Box mb={1} fontSize={'sm'} color={'myGray.900'}>
              {t('account_team:login_username')}
            </Box>
            <Input
              bg={'myGray.50'}
              placeholder={t('account_team:login_username_placeholder')}
              {...register('username', { required: true })}
              isInvalid={!!errors.username}
            />
          </Box>

          <Box>
            <Box mb={1} fontSize={'sm'} color={'myGray.900'}>
              {t('account_team:initial_password')}
            </Box>
            <Input
              bg={'myGray.50'}
              type={'password'}
              autoComplete={'new-password'}
              placeholder={t('account_team:initial_password_placeholder')}
              {...register('password', { required: true, minLength: 6 })}
              isInvalid={!!errors.password}
            />
          </Box>

          <Box>
            <Box mb={1} fontSize={'sm'} color={'myGray.900'}>
              {t('account_team:confirm_password')}
            </Box>
            <Input
              bg={'myGray.50'}
              type={'password'}
              autoComplete={'new-password'}
              {...register('confirmPassword', {
                required: true,
                validate: (val) => val === getValues('password')
              })}
              isInvalid={!!errors.confirmPassword}
            />
            {errors.confirmPassword && (
              <Box mt={1} fontSize={'xs'} color={'red.500'}>
                {t('account_team:password_not_match')}
              </Box>
            )}
          </Box>

          <Box>
            <Box mb={1} fontSize={'sm'} color={'myGray.900'}>
              {t('account_team:member_display_name')}
            </Box>
            <Input
              bg={'myGray.50'}
              placeholder={t('account_team:member_display_name_placeholder')}
              {...register('memberName')}
            />
          </Box>
        </Flex>
      </ModalBody>

      <ModalFooter gap={3}>
        <Button variant={'whiteBase'} onClick={onClose}>
          {t('common:Cancel')}
        </Button>
        <Button isLoading={loading} onClick={handleSubmit((data) => onCreate(data))}>
          {t('common:Confirm')}
        </Button>
      </ModalFooter>
    </MyModal>
  );
}

export default AddMemberModal;
