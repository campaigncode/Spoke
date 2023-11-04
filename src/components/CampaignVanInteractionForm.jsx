import PropTypes from "prop-types";
import React from "react";
import Form from "react-formal";
import CampaignFormSectionHeading from "./CampaignFormSectionHeading";
import GSForm from "./forms/GSForm";
import GSSubmitButton from "./forms/GSSubmitButton";
import * as yup from "yup";
import { dataTest } from "../lib/attributes";
import { Autocomplete } from "@material-ui/lab";
import { TextField } from "@material-ui/core";

// TODO
// DONE: Update schema
// DONE: Write autocomplete function (implemented using MUI component)
// Pull VAN API in (fetch campaigns from server)
// Make it only appear when VAN API keys are set

const FormSchemaBeforeStarted = {
  vanCampaignId: yup
    .string()
    .optional()
    .nullable()
};

const FormSchemaAfterStarted = {
  vanCampaignId: yup
    .string()
    .optional()
    .nullable()
};

// function showSearch() {
//     const { orgTexters } = this.props;
//     const { texters } = this.formValues();

//     const dataSource = orgTexters
//       .filter(orgTexter => !texters.find(texter => texter.id === orgTexter.id))
//       .filter(orgTexter => getHighestRole(orgTexter.roles) !== "SUSPENDED");

//     const autocomplete = (
//       <Autocomplete
//         {...dataTest("texterSearch")}
//         autoFocus
//         getOptionLabel={({ displayName }) => displayName}
//         style={inlineStyles.autocomplete}
//         options={dataSource}
//         renderInput={params => {
//           return <TextField {...params} label="Search for texters to assign" />;
//         }}
//         onChange={(event, value) => {
//           // If you're searching but get no match, value is a string
//           // representing your search term, but we only want to handle matches
//           if (typeof value === "object" && value !== null) {
//             const texterId = value.id;
//             const newTexter = this.props.orgTexters.find(
//               texter => texter.id === texterId
//             );
//             this.onChange({
//               texters: [
//                 ...this.formValues().texters,
//                 {
//                   id: texterId,
//                   firstName: newTexter.firstName,
//                   assignment: {
//                     contactsCount: 0,
//                     needsMessageCount: 0
//                   }
//                 }
//               ]
//             });
//           }
//         }}
//       />
//     );
//     return <div>{orgTexters.length > 0 ? autocomplete : null}</div>;
//   }

export default class CampaignVanInteractionForm extends React.Component {
  render() {
    const formSchema = this.props.ensureComplete
      ? yup.object(FormSchemaAfterStarted)
      : yup.object(FormSchemaBeforeStarted);

    return (
      <div>
        <CampaignFormSectionHeading title="Select the VAN Campaign to connect to" />
        <GSForm
          schema={formSchema}
          value={this.props.formValues}
          onChange={this.props.onChange}
          onSubmit={this.props.onSubmit}
          {...dataTest("campaignBasicsForm")}
        >
          <Autocomplete
            name="vanCampaignId"
            renderInput={params => {
              return <TextField {...params} label="Choose a campaign below" />;
            }}
            options={["a", "b", "c"]}
          />
          <Form.Submit
            as={GSSubmitButton}
            label={this.props.saveLabel}
            disabled={
              this.props.saveDisabled ||
              !formSchema.isValidSync(this.props.formValues)
            }
          />
        </GSForm>
      </div>
    );
  }
}

CampaignVanInteractionForm.propTypes = {
  formValues: PropTypes.shape({
    vanCampaignId: PropTypes.string
  }),
  onChange: PropTypes.func,
  onSubmit: PropTypes.func,
  saveLabel: PropTypes.string,
  saveDisabled: PropTypes.bool,
  ensureComplete: PropTypes.bool
};
