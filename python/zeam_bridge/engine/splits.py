from .abi import Abi
from .core import Address, Hex, Keccak, Num


class Splits:
    PULL_SPLIT_FACTORY = "0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1"
    WAREHOUSE = "0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8"
    SPLIT_WALLET_IMPLEMENTATION = "0x98254AeDb6B2c30b70483064367f0BA24ca86244"
    TOTAL = 1000000
    FEE_PPM = 99900
    REALM = "ZEAM Pass"
    SPLIT = "(address[],uint256[],uint256,uint16)"

    @staticmethod
    def fee_split(payout, fee, fee_ppm=FEE_PPM):
        payout = Address.checksum(payout)
        fee = Address.checksum(fee)
        if payout == fee:
            raise ValueError("the payout and the fee recipient must differ")
        return {
            "recipients": [payout, fee],
            "allocations": [str(Splits.TOTAL - int(fee_ppm)), str(int(fee_ppm))],
            "totalAllocation": str(Splits.TOTAL),
            "distributionIncentive": 0,
        }

    @staticmethod
    def whole_split(fee):
        return {
            "recipients": [Address.checksum(fee)],
            "allocations": [str(Splits.TOTAL)],
            "totalAllocation": str(Splits.TOTAL),
            "distributionIncentive": 0,
        }

    @staticmethod
    def salt_for(realm, name):
        return Keccak.utf8(f"{realm} seller {name}")

    @staticmethod
    def split_tuple(split):
        return [
            [Address.checksum(r) for r in split["recipients"]],
            [Num.dec(a) for a in split["allocations"]],
            Num.dec(split["totalAllocation"]),
            int(Num.dec(split["distributionIncentive"])),
        ]

    @staticmethod
    def create2_salt(split, owner, salt):
        encoded = Abi.encode([Splits.SPLIT, "address"], [Splits.split_tuple(split), Address.checksum(owner)])
        return Keccak.hex(Hex.to_bin(encoded) + Hex.to_bin(salt))

    @staticmethod
    def clone_init_code(implementation=SPLIT_WALLET_IMPLEMENTATION):
        return ("0x60593d8160093d39f336602c57343d527f"
                "9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff"
                "593da1005b3d3d3d3d363d3d37363d73"
                + Address.checksum(implementation)[2:].lower()
                + "5af43d3d93803e605757fd5bf3"
                + "00" * 15)

    @staticmethod
    def create2_address(deployer, salt, init_code):
        h = Keccak.hash(b"\xff" + Hex.to_bin(Address.checksum(deployer)) + Hex.to_bin(salt) + Keccak.hash(Hex.to_bin(init_code)))
        return Address.checksum(Hex.from_bin(h[12:]))

    @staticmethod
    def predict_address(split, owner, salt):
        return Splits.create2_address(Splits.PULL_SPLIT_FACTORY, Splits.create2_salt(split, owner, salt), Splits.clone_init_code())

    @staticmethod
    def encode_create_split_deterministic(split, owner, creator, salt):
        return Abi.encode_call("createSplitDeterministic(" + Splits.SPLIT + ",address,address,bytes32)",
                               [Splits.split_tuple(split), Address.checksum(owner), Address.checksum(creator), salt])

    @staticmethod
    def encode_is_deployed(split, owner, salt):
        return Abi.encode_call("isDeployed(" + Splits.SPLIT + ",address,bytes32)", [Splits.split_tuple(split), Address.checksum(owner), salt])

    @staticmethod
    def decode_is_deployed(data):
        address, deployed = Abi.decode(["address", "bool"], data)
        return {"address": address, "deployed": deployed}

    @staticmethod
    def encode_predict_deterministic_address(split, owner, salt):
        return Abi.encode_call("predictDeterministicAddress(" + Splits.SPLIT + ",address,bytes32)",
                               [Splits.split_tuple(split), Address.checksum(owner), salt])

    @staticmethod
    def encode_distribute(split, token, distributor):
        return Abi.encode_call("distribute(" + Splits.SPLIT + ",address,address)",
                               [Splits.split_tuple(split), Address.checksum(token), Address.checksum(distributor)])

    @staticmethod
    def encode_get_split_balance(token):
        return Abi.encode_call("getSplitBalance(address)", [Address.checksum(token)])

    @staticmethod
    def decode_get_split_balance(data):
        split_balance, warehouse_balance = Abi.decode(["uint256", "uint256"], data)
        return {"splitBalance": split_balance, "warehouseBalance": warehouse_balance}

    @staticmethod
    def encode_warehouse_withdraw(owner, token):
        return Abi.encode_call("withdraw(address,address)", [Address.checksum(owner), Address.checksum(token)])

    @staticmethod
    def token_id(token):
        return str(int(Address.checksum(token)[2:], 16))

    @staticmethod
    def encode_warehouse_balance_of(owner, token_id):
        ident = Splits.token_id(token_id) if Address.is_address(token_id) else token_id
        return Abi.encode_call("balanceOf(address,uint256)", [Address.checksum(owner), ident])
