import React from 'react';
import { useForm } from 'react-hook-form';
import { useClientTranslation } from '@fastgpt/web/i18n/useClientTranslation';
import { useRequest } from '@fastgpt/web/hooks/useRequest';
import MyModal from '@fastgpt/web/components/v2/common/MyModal';
import { Box, Button, Flex, Input, ModalBody, ModalFooter } from '@chakra-ui/react';
import { putResetMemberPassword } from '@/web/support/user/team/api';

type ResetPasswordFormType = {
  password: string;
  confirmPassword: string;
};

/**
 * 开源版「管理员重置成员密码」弹窗。
 * 提交成功后该成员的全部登录会话会被服务端强制下线。
 */
function ResetPasswordModal({
  tmbId,
  memberName,
  onClose,
  onSuccess
}: {
  tmbId: string;
  memberName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useClientTranslation(['account_team']);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors }
  } = useForm<ResetPasswordFormType>({
    defaultValues: { password: '', confirmPassword: '' }
  });

  const { runAsync: onReset, loading } = useRequest(
    async (data: ResetPasswordFormType) => putResetMemberPassword(tmbId, data.password),
    {
      onSuccess() {
        onSuccess();
        onClose();
      },
      successToast: t('common:update_success'),
      errorToast: t('common:update_failed')
    }
  );

  return (
    <MyModal
      isOpen
      onClose={onClose}
      title={t('account_team:reset_password_for', { username: memberName })}
      w={'30rem'}
    >
      <ModalBody>
        <Flex flexDirection={'column'} gap={4}>
          <Box fontSize={'sm'} color={'myGray.600'}>
            {t('account_team:reset_password_tip')}
          </Box>

          <Box>
            <Box mb={1} fontSize={'sm'} color={'myGray.900'}>
              {t('account_team:new_password')}
            </Box>
            <Input
              bg={'myGray.50'}
              type={'password'}
              autoComplete={'new-password'}
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
        </Flex>
      </ModalBody>

      <ModalFooter gap={3}>
        <Button variant={'whiteBase'} onClick={onClose}>
          {t('common:Cancel')}
        </Button>
        <Button isLoading={loading} onClick={handleSubmit((data) => onReset(data))}>
          {t('common:Confirm')}
        </Button>
      </ModalFooter>
    </MyModal>
  );
}

export default ResetPasswordModal;
