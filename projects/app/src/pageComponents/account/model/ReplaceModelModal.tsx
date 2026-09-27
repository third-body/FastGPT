import React, { useRef, useState } from 'react';
import {
  Box,
  Button,
  Flex,
  ModalBody,
  ModalFooter,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr
} from '@chakra-ui/react';
import MyModal from '@fastgpt/web/components/common/MyModal';
import MySelect from '@fastgpt/web/components/common/MySelect';
import { useClientTranslation } from '@fastgpt/web/i18n/useClientTranslation';
import { useRequest } from '@fastgpt/web/hooks/useRequest';
import type { SystemModelDataType } from '@fastgpt/global/core/ai/model.schema';
import type {
  ModelReplaceItemKey,
  ReplaceSystemModelResponse
} from '@fastgpt/global/openapi/admin/core/ai/model/api';
import { postReplaceSystemModel, postReplaceSystemModelPreview } from '@/web/core/ai/config';

/**
 * 模型一键替换弹窗：选择同类型、已启用的目标模型后先预览引用数量，确认后执行并展示结果。
 * 预览与执行都由后端完成，前端只负责展示；执行完成后通知父组件刷新模型列表。
 */
const ReplaceModelModal = ({
  sourceModel,
  models,
  onClose,
  onSuccess
}: {
  sourceModel: SystemModelDataType;
  models: SystemModelDataType[];
  onClose: () => void;
  onSuccess: () => void;
}) => {
  const { t } = useClientTranslation('config_model');
  const [targetModelId, setTargetModelId] = useState<string>();
  const [preview, setPreview] = useState<ReplaceSystemModelResponse>();
  const [result, setResult] = useState<ReplaceSystemModelResponse>();

  const targetList = models
    .filter(
      (model) =>
        model.isActive && model.type === sourceModel.type && model.modelId !== sourceModel.modelId
    )
    .map((model) => ({ label: model.name, value: model.modelId }));

  // 快速切换目标时，先发出的预览可能后返回；只接受当前选中目标的预览结果
  const latestTargetRef = useRef<string>();
  const { runAsync: runPreview, loading: previewing } = useRequest(async (modelId: string) => {
    const res = await postReplaceSystemModelPreview({
      sourceModelId: sourceModel.modelId,
      targetModelId: modelId
    });
    if (latestTargetRef.current === modelId) setPreview(res);
  });
  const { runAsync: runReplace, loading: replacing } = useRequest(
    () =>
      postReplaceSystemModel({ sourceModelId: sourceModel.modelId, targetModelId: targetModelId! }),
    {
      onSuccess(res) {
        setResult(res);
        onSuccess();
      }
    }
  );

  const report = result ?? preview;
  const itemLabel: Record<ModelReplaceItemKey, string> = {
    datasetAgentModel: t('config_model:model.replace_item_dataset_agent'),
    datasetVlmModel: t('config_model:model.replace_item_dataset_vlm'),
    datasetVlmModelCleared: t('config_model:model.replace_item_dataset_vlm_cleared'),
    datasetVectorModel: t('config_model:model.replace_item_dataset_vector'),
    app: t('config_model:model.replace_item_app'),
    appVersion: t('config_model:model.replace_item_app_version'),
    appTemplate: t('config_model:model.replace_item_app_template'),
    evaluation: t('config_model:model.replace_item_evaluation'),
    defaultModel: t('config_model:model.replace_item_default_model')
  };
  const totalMatched = report?.items.reduce((sum, item) => sum + item.matched, 0) ?? 0;

  return (
    <MyModal
      isOpen
      onClose={onClose}
      iconSrc="modal/edit"
      title={t('config_model:model.replace_model_title', { name: sourceModel.name })}
      w={'600px'}
    >
      <ModalBody>
        <Box fontSize={'sm'} color={'myGray.600'} mb={3}>
          {t('config_model:model.replace_model_tip')}
        </Box>
        <MySelect
          value={targetModelId}
          placeholder={t('config_model:model.replace_select_target')}
          list={targetList}
          isDisabled={!!result}
          onChange={(value: string) => {
            latestTargetRef.current = value;
            setTargetModelId(value);
            setPreview(undefined);
            runPreview(value);
          }}
        />

        {report && (
          <Box mt={4}>
            {!result && report.rebuildDataCount > 0 && (
              <Box fontSize={'sm'} color={'orange.600'} mb={2}>
                {t('config_model:model.replace_rebuild_tip', { count: report.rebuildDataCount })}
              </Box>
            )}
            {!result && report.targetRestricted && (
              <Box fontSize={'sm'} color={'orange.600'} mb={2}>
                {t('config_model:model.replace_target_restricted_tip')}
              </Box>
            )}
            {totalMatched === 0 ? (
              <Box fontSize={'sm'} color={'myGray.500'}>
                {t('config_model:model.replace_no_reference')}
              </Box>
            ) : (
              <TableContainer>
                <Table size={'sm'}>
                  <Thead>
                    <Tr>
                      <Th>{t('config_model:model.replace_col_item')}</Th>
                      <Th>{t('config_model:model.replace_col_matched')}</Th>
                      {result && <Th>{t('config_model:model.replace_col_updated')}</Th>}
                      {result && <Th>{t('config_model:model.replace_col_skipped')}</Th>}
                    </Tr>
                  </Thead>
                  <Tbody>
                    {report.items.map((item) => (
                      <Tr key={item.key}>
                        <Td>{itemLabel[item.key]}</Td>
                        <Td>{item.matched}</Td>
                        {result && <Td>{item.updated}</Td>}
                        {result && <Td>{item.skipped}</Td>}
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </TableContainer>
            )}
            {report.failures.length > 0 && (
              <Box mt={3} fontSize={'sm'}>
                <Box color={result ? 'red.600' : 'orange.600'} mb={1}>
                  {t('config_model:model.replace_failures')}
                </Box>
                {report.failures.map((failure) => (
                  <Flex key={`${failure.key}-${failure.resourceId}`} gap={2} color={'myGray.600'}>
                    <Box flexShrink={0}>{itemLabel[failure.key]}</Box>
                    <Box flexShrink={0}>{failure.name || failure.resourceId}</Box>
                    <Box>{failure.reason}</Box>
                  </Flex>
                ))}
              </Box>
            )}
          </Box>
        )}
      </ModalBody>
      <ModalFooter>
        {result ? (
          <Button onClick={onClose}>{t('common:Close')}</Button>
        ) : (
          <>
            <Button variant={'whiteBase'} mr={3} onClick={onClose}>
              {t('common:Cancel')}
            </Button>
            <Button
              variant={'dangerFill'}
              isLoading={replacing || previewing}
              isDisabled={!targetModelId || !preview || totalMatched === 0}
              onClick={runReplace}
            >
              {t('config_model:model.replace_confirm')}
            </Button>
          </>
        )}
      </ModalFooter>
    </MyModal>
  );
};

export default ReplaceModelModal;
