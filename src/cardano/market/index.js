import Loader from "./loader.js";
import {
  assetsToValue,
  fromAscii,
  fromHex,
  getTradeDetails,
  lovelacePercentage,
  toBytesNum,
  toHex,
  valueToAssets,
} from "./utils.js";
import { languageViews } from "./languageViews.js";
import { contract } from "./plutus.js";
import CoinSelection from "./coinSelection.js";
import {
  Address,
  PlutusData,
  TransactionUnspentOutput,
} from "./custom_modules/@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib.js";

const DATUM_LABEL = 405;
const ADDRESS_LABEL = 406;

// Validator
const CONTRACT = () => {
  const scripts = Loader.Cardano.PlutusScripts.new();
  scripts.add(Loader.Cardano.PlutusScript.new(fromHex(contract)));
  return scripts;
};

const CONTRACT_ADDRESS = () =>
  Loader.Cardano.Address.from_bech32(
    "addr_test1wrar7ewvyxc4h8sg9xgmk8kyyzlpktsmcpwnakp24nuh8ucma9934"
  );

// Datums -- This is going to take a bit to unpack everything and then we need to construct our transactions.
const OFFER = ({ tradeOwner, requestedAmount, privateRecip }) => {
  const fieldsInner = Loader.Cardano.PlutusList.new();
  fieldsInner.add(Loader.Cardano.PlutusData.new_bytes(fromHex(tradeOwner)));
  fieldsInner.add(Loader.Cardano.PlutusData.new_bytes(requestedAmount));
      //Loader.Cardano.BigInt.from(requestedAmount)
  fieldsInner.add(Loader.Cardano.PlutusData.new_bytes(fromHex(privateRecip)));
  const tradeDetails = Loader.Cardano.PlutusList.new();
  tradeDetails.add(
    Loader.Cardano.PlutusData.new_constr_plutus_data(
      Loader.Cardano.ConstrPlutusData.new(
        Loader.Cardano.Int.new_i32(0),
        fieldsInner
      )
    )
  );
  const datum = Loader.Cardano.PlutusData.new_constr_plutus_data(
    Loader.Cardano.ConstrPlutusData.new(
      Loader.Cardano.Int.new_i32(DATUM_TYPE.Offer),
      tradeDetails
    )
  );
  return datum;
};

const DATUM_TYPE = {
  Offer: 0,
}

const BUY = (index) => {
  const redeemerData = Loader.Cardano.PlutusData.new_constr_plutus_data(
    Loader.Cardano.ConstrPlutusData.new(
      Loader.Cardano.Int.new_i32(0),
      Loader.Cardano.PlutusList.new()
    )
  );
  const redeemer = Loader.Cardano.Redeemer.new(
    Loader.Cardano.RedeemerTag.new_spend(),
    Loader.Cardano.BigNum.from_str(index),
    redeemerData,
    Loader.Cardano.ExUnits.new(
      Loader.Cardano.BigNum.from_str("62200"),
      Loader.Cardano.BigNum.from_str("18489133")
    )
  );
  return redeemer;
};

const CANCEL = (index) => {
  const redeemerData = Loader.Cardano.PlutusData.new_constr_plutus_data(
    Loader.Cardano.ConstrPlutusData.new(
      Loader.Cardano.Int.new_i32(1),
      Loader.Cardano.PlutusList.new()
    )
  );
  const redeemer = Loader.Cardano.Redeemer.new(
    Loader.Cardano.RedeemerTag.new_spend(),
    Loader.Cardano.BigNum.from_str(index),
    redeemerData,
    Loader.Cardano.ExUnits.new(
      Loader.Cardano.BigNum.from_str("62200"),
      Loader.Cardano.BigNum.from_str("18489133")
    )
  );
  return redeemer;
};

const toFraction = (p) => Math.floor(1 / (p / 1000));

class Escrow {
  constructor({ base, projectId }) {
    this.provider = { base, projectId };
  }

  /**
   *
   * @typedef {Object} TradeUtxo
   * @property {PlutusData} datum
   * @property {Address} tradeOwnerAddress
   * @property {TransactionUnspentOutput} utxo
   * @property {string} budId
   * @property {string} lovelace bid amount or requested amount from offer
   */

  /**
   *@private
   */
  async blockfrostRequest(endpoint, headers, body) {
    return await fetch(this.provider.base + endpoint, {
      headers: {
        project_id: this.provider.projectId,
        ...headers,
        "User-Agent": "cardano-escrow",
      },
      method: body ? "POST" : "GET",
      body,
    }).then((res) => res.json());
  }

  /**
   * @private
   * @returns {TradeUtxo[]}
   */
  async getUtxo(offer) {
    const utxos = await this.blockfrostRequest(
      `/addresses/${CONTRACT_ADDRESS().to_bech32()}/utxos`
    );

    return await Promise.all(
      utxos.map(async (utxo) => {
        if (assetsToValue(utxo.amount) == offer) {
          return {
            offer,
            utxo: Loader.Cardano.TransactionUnspentOutput.new(
              Loader.Cardano.TransactionInput.new(
                Loader.Cardano.TransactionHash.from_bytes(fromHex(utxo.tx_hash)),
                utxo.output_index
              ),
              Loader.Cardano.TransactionOutput.new(
                CONTRACT_ADDRESS(),
                assetsToValue(utxo.amount)
              )
            ),
          };
        }
        throw new Error("The utxo value did not match the offer expected.");
      })
    );
  }

  /**
   *@private
   */
  async initTx() {
    const txBuilder = Loader.Cardano.TransactionBuilder.new(
      Loader.Cardano.LinearFee.new(
        Loader.Cardano.BigNum.from_str(
          this.protocolParameters.linearFee.minFeeA
        ),
        Loader.Cardano.BigNum.from_str(
          this.protocolParameters.linearFee.minFeeB
        )
      ),
      Loader.Cardano.BigNum.from_str(this.protocolParameters.minUtxo),
      Loader.Cardano.BigNum.from_str(this.protocolParameters.poolDeposit),
      Loader.Cardano.BigNum.from_str(this.protocolParameters.keyDeposit),
      this.protocolParameters.maxValSize,
      this.protocolParameters.maxTxSize,
      this.protocolParameters.priceMem,
      this.protocolParameters.priceStep,
      Loader.Cardano.LanguageViews.new(Buffer.from(languageViews, "hex"))
    );
    const datums = Loader.Cardano.PlutusList.new();
    const metadata = { [ADDRESS_LABEL]: {}};
    const outputs = Loader.Cardano.TransactionOutputs.new();
    return { txBuilder, datums, metadata, outputs };
  }

  /**
   * @private
   */
  createOutput(
    address,
    value,
    { datum, index, tradeOwnerAddress, metadata } = {}
  ) {
    const v = value;
    const minAda = Loader.Cardano.min_ada_required(
      v,
      Loader.Cardano.BigNum.from_str(this.protocolParameters.minUtxo),
      datum && Loader.Cardano.hash_plutus_data(datum)
    );
    if (minAda.compare(v.coin()) == 1) v.set_coin(minAda);
    const output = Loader.Cardano.TransactionOutput.new(address, v);
    if (datum) {
      output.set_data_hash(Loader.Cardano.hash_plutus_data(datum));
      // metadata[DATUM_LABEL][index] = "0x" + toHex(datum.to_bytes());
    }
    if (tradeOwnerAddress) {
      metadata[ADDRESS_LABEL].address = "0x" + toHex(tradeOwnerAddress.to_address().to_bytes());
    }
    return output;
  }

  /**
   * @private
   */
  setCollateral(txBuilder, utxos) {
    const inputs = Loader.Cardano.TransactionInputs.new();
    utxos.forEach((utxo) => {
      inputs.add(utxo.input());
    });
    txBuilder.set_collateral(inputs);
  }

  /**
   * @private
   */
  async finalizeTx({
    txBuilder,
    changeAddress,
    utxos,
    outputs,
    datums,
    metadata,
    scriptUtxo,
    action,
  }) {
    const transactionWitnessSet = Loader.Cardano.TransactionWitnessSet.new();
    let { input, change } = CoinSelection.randomImprove(
      utxos,
      outputs,
      8,
      scriptUtxo ? [scriptUtxo] : []
    );
    input.forEach((utxo) => {
      txBuilder.add_input(
        utxo.output().address(),
        utxo.input(),
        utxo.output().amount()
      );
    });
    for (let i = 0; i < outputs.len(); i++) {
      txBuilder.add_output(outputs.get(i));
    }
    if (scriptUtxo) {
      const redeemers = Loader.Cardano.Redeemers.new();
      const redeemerIndex = txBuilder
        .index_of_input(scriptUtxo.input())
        .toString();
      redeemers.add(action(redeemerIndex));
      txBuilder.set_redeemers(
        Loader.Cardano.Redeemers.from_bytes(redeemers.to_bytes())
      );
      txBuilder.set_plutus_data(
        Loader.Cardano.PlutusList.from_bytes(datums.to_bytes())
      );
      txBuilder.set_plutus_scripts(CONTRACT());
      const collateral = (await window.cardano.getCollateral()).map((utxo) =>
        Loader.Cardano.TransactionUnspentOutput.from_bytes(fromHex(utxo))
      );
      if (collateral.length <= 0) throw new Error("NO_COLLATERAL");
      this.setCollateral(txBuilder, collateral);

      transactionWitnessSet.set_plutus_scripts(CONTRACT());
      transactionWitnessSet.set_plutus_data(datums);
      transactionWitnessSet.set_redeemers(redeemers);
    }
    let aux_data;
    if (metadata) {
      aux_data = Loader.Cardano.AuxiliaryData.new();
      const generalMetadata = Loader.Cardano.GeneralTransactionMetadata.new();
      Object.keys(metadata).forEach((label) => {
        Object.keys(metadata[label]).length > 0 &&
          generalMetadata.insert(
            Loader.Cardano.BigNum.from_str(label),
            Loader.Cardano.encode_json_str_to_metadatum(
              JSON.stringify(metadata[label]),
              1
            )
          );
      });
      aux_data.set_metadata(generalMetadata);
      txBuilder.set_auxiliary_data(aux_data);
    }

    const changeMultiAssets = change.multiasset();

    // check if change value is too big for single output
    if (
      changeMultiAssets &&
      change.to_bytes().length * 2 > this.protocolParameters.maxValSize
    ) {
      const partialChange = Loader.Cardano.Value.new(
        Loader.Cardano.BigNum.from_str("0")
      );

      const partialMultiAssets = Loader.Cardano.MultiAsset.new();
      const policies = changeMultiAssets.keys();
      const makeSplit = () => {
        for (let j = 0; j < changeMultiAssets.len(); j++) {
          const policy = policies.get(j);
          const policyAssets = changeMultiAssets.get(policy);
          const assetNames = policyAssets.keys();
          const assets = Loader.Cardano.Assets.new();
          for (let k = 0; k < assetNames.len(); k++) {
            const policyAsset = assetNames.get(k);
            const quantity = policyAssets.get(policyAsset);
            assets.insert(policyAsset, quantity);
            //check size
            const checkMultiAssets = Loader.Cardano.MultiAsset.from_bytes(
              partialMultiAssets.to_bytes()
            );
            checkMultiAssets.insert(policy, assets);
            const checkValue = Loader.Cardano.Value.new(
              Loader.Cardano.BigNum.from_str("0")
            );
            checkValue.set_multiasset(checkMultiAssets);
            if (
              checkValue.to_bytes().length * 2 >=
              this.protocolParameters.maxValSize
            ) {
              partialMultiAssets.insert(policy, assets);
              return;
            }
          }
          partialMultiAssets.insert(policy, assets);
        }
      };
      makeSplit();
      partialChange.set_multiasset(partialMultiAssets);
      const minAda = Loader.Cardano.min_ada_required(
        partialChange,
        Loader.Cardano.BigNum.from_str(this.protocolParameters.minUtxo)
      );
      partialChange.set_coin(minAda);

      txBuilder.add_output(
        Loader.Cardano.TransactionOutput.new(
          changeAddress.to_address(),
          partialChange
        )
      );
    }

    txBuilder.add_change_if_needed(changeAddress.to_address());
    const txBody = txBuilder.build();
    const tx = Loader.Cardano.Transaction.new(
      txBody,
      Loader.Cardano.TransactionWitnessSet.from_bytes(
        transactionWitnessSet.to_bytes()
      ),
      aux_data
    );
    const size = tx.to_bytes().length * 2;
    console.log(size);
    if (size > this.protocolParameters.maxTxSize)
      throw new Error("MAX_SIZE_REACHED");
    let txVkeyWitnesses = await window.cardano.signTx(
      toHex(tx.to_bytes()),
      true
    );
    txVkeyWitnesses = Loader.Cardano.TransactionWitnessSet.from_bytes(
      fromHex(txVkeyWitnesses)
    );
    transactionWitnessSet.set_vkeys(txVkeyWitnesses.vkeys());
    const signedTx = Loader.Cardano.Transaction.new(
      tx.body(),
      transactionWitnessSet,
      tx.auxiliary_data()
    );

    console.log("Full Tx Size", signedTx.to_bytes().length);

    const txHash = await window.cardano.submitTx(toHex(signedTx.to_bytes()));
    return txHash;
  }

  async load() {
    await Loader.load();
    const p = await this.blockfrostRequest(`/epochs/latest/parameters`);
    console.log(JSON.stringify(p));
    this.protocolParameters = {
      linearFee: {
        minFeeA: p.min_fee_a.toString(),
        minFeeB: p.min_fee_b.toString(),
      },
      minUtxo: "1000000",
      poolDeposit: "500000000",
      keyDeposit: "2000000",
      maxValSize: "5000",
      maxTxSize: 16384,
      priceMem: 5.77e-2,
      priceStep: 7.21e-5,
    };

    this.contractInfo = {
      owner1: {
        address: Loader.Cardano.Address.from_bech32(
          "addr1w967qqlqwjwwg5lugxvnx2taudl5apvnynw8n5g4dvmfn7g0j8gtz"
        ),
        fee1: Loader.Cardano.BigNum.from_str("1000"), // 1.0%
        fee2: Loader.Cardano.BigNum.from_str("1111"), // 0.9%
      },
      owner2: {
        address: Loader.Cardano.Address.from_bech32(
          "addr1wy02upg5vew7dty35za98pl8v36whk5ucux8xqwt0gf9ycglp29ku"
        ),
        fee: Loader.Cardano.BigNum.from_str("10000"), // 0.1%
      },
    };

    CoinSelection.setProtocolParameters(
      this.protocolParameters.minUtxo,
      this.protocolParameters.linearFee.minFeeA,
      this.protocolParameters.linearFee.minFeeB,
      this.protocolParameters.maxTxSize.toString()
    );
  }

// Endpoints
  async offer(offer, requestedAmount, privateRecip) {
    const { txBuilder, datums, metadata, outputs } = await this.initTx();
    const walletAddress = Loader.Cardano.BaseAddress.from_address(
      Loader.Cardano.Address.from_bytes(
        fromHex((await window.cardano.getUsedAddresses())[0])
      )
    );

    const utxos = (await window.cardano.getUtxos()).map((utxo) =>
      Loader.Cardano.TransactionUnspentOutput.from_bytes(fromHex(utxo))
    );

    const offerDatum = OFFER({
      tradeOwner: toHex(walletAddress.payment_cred().to_keyhash().to_bytes()),
      requestedAmount: requestedAmount,
      privateRecip: privateRecip == "" ? toHex(walletAddress.payment_cred().to_keyhash().to_bytes()) : privateRecip
    });

    outputs.add(
      this.createOutput(
        CONTRACT_ADDRESS(),
        offer,
        {
          datum: offerDatum,
          index: 0,
          tradeOwnerAddress: walletAddress,
          metadata,
        }
      )
    );
    datums.add(offerDatum);

    const txHash = await this.finalizeTx({
      txBuilder,
      changeAddress: walletAddress,
      utxos,
      outputs,
      datums,
      metadata,
    });
    return txHash;
  }

  async getOffer(offer) {
    const offerUtxo = await this.getUtxo(offer);
    if (offerUtxo.length === 1) {
      return offerUtxo[0];
    }
    return null;
  }

  async purchase(tradeOwnerAddress, offer, requestedAmount) {
    const { txBuilder, datums, outputs } = await this.initTx();
    const walletAddress = Loader.Cardano.BaseAddress.from_address(
      Loader.Cardano.RewardAddress.from_bytes(
        fromHex((await window.cardano.getUsedAddresses())[0])
      )
    );

    const utxos = (await window.cardano.getUtxos()).map((utxo) =>
      Loader.Cardano.TransactionUnspentOutput.from_bytes(fromHex(utxo))
    );

    const offerUtxo = this.getOffer(offer);

    const offerDatum = OFFER({
      tradeOwner: toHex(tradeOwnerAddress.payment_cred().to_keyhash().to_bytes()),
      requestedAmount: requestedAmount,
      privateRecip: toHex(tradeOwnerAddress.payment_cred().to_keyhash().to_bytes())
    });
    datums.add(offerDatum);

    const value = offerUtxo.output().amount();

    outputs.add(this.createOutput(walletAddress.to_address(), value)); // buyer receiving Offer
    outputs.add(this.createOutput(this.contractInfo.owner1.address, assetsToValue([{unit: "lovelace", quantity: "4000000"}])));
    outputs.add(this.createOutput(this.contractInfo.owner2.address, assetsToValue([{unit: "lovelace", quantity: "1000000"}])));

    const requiredSigners = Loader.Cardano.Ed25519KeyHashes.new();
    requiredSigners.add(walletAddress.payment_cred().to_keyhash());
    txBuilder.set_required_signers(requiredSigners);

    const txHash = await this.finalizeTx({
      txBuilder,
      changeAddress: walletAddress,
      utxos,
      outputs,
      datums,
      scriptUtxo: offerUtxo.utxo,
      action: BUY,
    });
    return txHash;
  }

  async cancelOffer(tradeOwnerAddress, offer, requestedAmount) {
    const { txBuilder, datums, outputs } = await this.initTx();

    const walletAddress = Loader.Cardano.BaseAddress.from_address(
      Loader.Cardano.Address.from_bytes(
        fromHex((await window.cardano.getUsedAddresses())[0])
      )
    );

    const utxos = (await window.cardano.getUtxos()).map((utxo) =>
      Loader.Cardano.TransactionUnspentOutput.from_bytes(fromHex(utxo))
    );

    const offerUtxo = this.getOffer(offer);

    const offerDatum = OFFER({
      tradeOwner: toHex(tradeOwnerAddress.payment_cred().to_keyhash().to_bytes()),
      requestedAmount: requestedAmount,
      privateRecip: toHex(tradeOwnerAddress.payment_cred().to_keyhash().to_bytes())
    });
    datums.add(offerDatum);

    const value = offerUtxo.output().amount();

    outputs.add(this.createOutput(walletAddress.to_address(), value)); // Seller canceling offer.

    const requiredSigners = Loader.Cardano.Ed25519KeyHashes.new();
    requiredSigners.add(walletAddress.payment_cred().to_keyhash());
    txBuilder.set_required_signers(requiredSigners);

    const txHash = await this.finalizeTx({
      txBuilder,
      changeAddress: walletAddress,
      utxos,
      outputs,
      datums,
      scriptUtxo: offerUtxo.utxo,
      action: CANCEL,
    });
    return txHash;
  }

}

export default Escrow;