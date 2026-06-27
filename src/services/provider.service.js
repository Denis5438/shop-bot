const PROVIDERS = {
  local: {
    id: 'local',
    label: '🏠 Мои ключи',
    shortLabel: 'Мои ключи',
  },
  u1traby: {
    id: 'u1traby',
    label: '🌐 U1traby',
    shortLabel: 'U1traby',
  },
};

const FALLBACK_PROVIDER_BY_TYPE = {
  key: 'local',
  gpt_activation: 'u1traby',
  manual: 'local',
};

const getProvidersForProductType = (type) => {
  switch (type) {
    case 'gpt_activation':
      return ['u1traby'];
    case 'key':
      return ['local', 'u1traby'];
    case 'manual':
    default:
      return ['local'];
  }
};

const resolveProductProvider = (product) => {
  if (product?.provider && PROVIDERS[product.provider]) {
    return product.provider;
  }

  return FALLBACK_PROVIDER_BY_TYPE[product?.type] || 'local';
};

const resolveOrderProvider = (order, product = null) => {
  if (order?.provider && PROVIDERS[order.provider]) {
    return order.provider;
  }

  return resolveProductProvider(product || order);
};

const normalizeProviderForType = (type, provider) => {
  const allowed = getProvidersForProductType(type);
  return allowed.includes(provider) ? provider : allowed[0];
};

const getProviderLabel = (provider) => PROVIDERS[provider]?.label || provider || 'Не задан';
const getProviderShortLabel = (provider) => PROVIDERS[provider]?.shortLabel || provider || 'Не задан';

const buildProviderMatch = (provider) => {
  if (provider === 'local' || provider === 'u1traby') {
    return { $in: [provider, null] };
  }

  return provider;
};

const buildKeyQueryForProduct = (product, extra = {}) => ({
  productId: product._id,
  provider: buildProviderMatch(resolveProductProvider(product)),
  ...extra,
});

const providerRequiresUserConfirmation = (provider) => provider === 'u1traby';
const providerSupportsActivation = (provider) => provider === 'u1traby';

module.exports = {
  PROVIDERS,
  buildKeyQueryForProduct,
  getProviderLabel,
  getProviderShortLabel,
  getProvidersForProductType,
  normalizeProviderForType,
  providerRequiresUserConfirmation,
  providerSupportsActivation,
  resolveOrderProvider,
  resolveProductProvider,
};
