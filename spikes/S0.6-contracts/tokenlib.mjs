// Token configuration builder for Dash Platform v1 ($formatVersion 0) contracts.
// Mirrors the serialized shape validated by DataContract.fromJSON (platform v9+).
const RULE = { // ChangeControlRules → MainGroup makes the control group the authority
  $formatVersion: '0',
  authorizedToMakeChange: 'MainGroup',
  adminActionTakers: 'MainGroup',
  changingAuthorizedActionTakersToNoOneAllowed: false,
  changingAdminActionTakersToNoOneAllowed: false,
  selfChangingAdminActionTakersAllowed: false,
};
const OWNER_RULE = {
  $formatVersion: '0',
  authorizedToMakeChange: 'ContractOwner',
  adminActionTakers: 'ContractOwner',
  changingAuthorizedActionTakersToNoOneAllowed: false,
  changingAdminActionTakersToNoOneAllowed: false,
  selfChangingAdminActionTakersAllowed: false,
};
export function token({ singular, plural, owner }) {
  return {
    $formatVersion: '0',
    conventions: { $formatVersion: '0', localizations: { en: { $formatVersion: '0', shouldCapitalize: true, singularForm: singular, pluralForm: plural } }, decimals: 0 },
    conventionsChangeRules: OWNER_RULE,
    baseSupply: 1000000000,
    maxSupply: null,
    keepsHistory: { $formatVersion: '0', keepsTransferHistory: true, keepsFreezingHistory: true, keepsMintingHistory: true, keepsBurningHistory: true, keepsDirectPricingHistory: true, keepsDirectPurchaseHistory: true },
    startAsPaused: false,
    allowTransferToFrozenBalance: true,
    maxSupplyChangeRules: OWNER_RULE,
    distributionRules: {
      $formatVersion: '0',
      perpetualDistribution: null,
      perpetualDistributionRules: OWNER_RULE,
      preProgrammedDistribution: null,
      newTokensDestinationIdentity: null,
      newTokensDestinationIdentityRules: OWNER_RULE,
      mintingAllowChoosingDestination: true,
      mintingAllowChoosingDestinationRules: OWNER_RULE,
      changeDirectPurchasePricingRules: OWNER_RULE,
    },
    marketplaceRules: { $formatVersion: '0', tradeMode: 'NotTradeable', tradeModeChangeRules: OWNER_RULE },
    manualMintingRules: RULE,
    manualBurningRules: RULE,
    freezeRules: RULE,
    unfreezeRules: RULE,
    destroyFrozenFundsRules: RULE,
    emergencyActionRules: RULE,
    mainControlGroup: 0,
    mainControlGroupCanBeModified: 'ContractOwner',
    description: null,
  };
}
