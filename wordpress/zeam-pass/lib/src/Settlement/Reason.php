<?php

namespace ZeamPass\Settlement;

final class Reason
{
    const CHANNEL_NOT_FOUND = 'invalid_batch_settlement_evm_channel_not_found';
    const TOKEN_MISMATCH = 'invalid_batch_settlement_evm_token_mismatch';
    const VOUCHER_SIGNATURE = 'invalid_batch_settlement_evm_voucher_signature';
    const EXCEEDS_BALANCE = 'invalid_batch_settlement_evm_cumulative_exceeds_balance';
    const BELOW_CLAIMED = 'invalid_batch_settlement_evm_cumulative_below_claimed';
    const INSUFFICIENT_BALANCE = 'invalid_batch_settlement_evm_insufficient_balance';
    const DEPOSIT_TRANSACTION_FAILED = 'invalid_batch_settlement_evm_deposit_transaction_failed';
    const INVALID_SCHEME = 'invalid_batch_settlement_evm_scheme';
    const NETWORK_MISMATCH = 'invalid_batch_settlement_evm_network_mismatch';
    const MISSING_EIP712_DOMAIN = 'invalid_batch_settlement_evm_missing_eip712_domain';
    const VALID_BEFORE = 'invalid_batch_settlement_evm_payload_authorization_valid_before';
    const VALID_AFTER = 'invalid_batch_settlement_evm_payload_authorization_valid_after';
    const RECEIVE_AUTHORIZATION_SIGNATURE = 'invalid_batch_settlement_evm_receive_authorization_signature';
    const ERC3009_AUTHORIZATION_REQUIRED = 'invalid_batch_settlement_evm_erc3009_authorization_required';
    const PAYLOAD_TYPE = 'invalid_batch_settlement_evm_payload_type';
    const CHANNEL_ID_MISMATCH = 'invalid_batch_settlement_evm_channel_id_mismatch';
    const CHANNEL_ID_INVALID = 'invalid_batch_settlement_evm_channel_id_invalid';
    const DEPOSIT_SIMULATION_FAILED = 'invalid_batch_settlement_evm_deposit_simulation_failed';
    const FACTORY_NOT_ALLOWED = 'invalid_batch_settlement_evm_eip6492_factory_not_allowed';
    const RPC_READ_FAILED = 'invalid_batch_settlement_evm_rpc_read_failed';
    const PERMIT2_AUTHORIZATION_REQUIRED = 'invalid_batch_settlement_evm_permit2_authorization_required';
    const PERMIT2_INVALID_SPENDER = 'invalid_batch_settlement_evm_permit2_invalid_spender';
    const PERMIT2_AMOUNT_MISMATCH = 'invalid_batch_settlement_evm_permit2_amount_mismatch';
    const PERMIT2_DEADLINE_EXPIRED = 'invalid_batch_settlement_evm_permit2_deadline_expired';
    const PERMIT2_INVALID_SIGNATURE = 'invalid_batch_settlement_evm_permit2_invalid_signature';
    const PERMIT2_ALLOWANCE_REQUIRED = 'invalid_batch_settlement_evm_permit2_allowance_required';
    const CUMULATIVE_AMOUNT_MISMATCH = 'invalid_batch_settlement_evm_cumulative_amount_mismatch';
    const CHANNEL_BUSY = 'invalid_batch_settlement_evm_channel_busy';
    const VERIFICATION_STATE_UNAVAILABLE = 'invalid_batch_settlement_evm_verification_state_unavailable';
    const CHARGE_EXCEEDS_SIGNED_CUMULATIVE = 'invalid_batch_settlement_evm_charge_exceeds_signed_cumulative';
    const MISSING_CHANNEL = 'invalid_batch_settlement_evm_missing_channel';
    const REFUND_SETTLING = 'refund_settling';
}
