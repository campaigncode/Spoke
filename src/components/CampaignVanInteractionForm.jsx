import PropTypes from "prop-types";
import React from "react";
import Form from "react-formal";
import CampaignFormSectionHeading from "./CampaignFormSectionHeading";
import GSForm from "./forms/GSForm";
import GSSubmitButton from "./forms/GSSubmitButton";
import * as yup from "yup";
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

export default class CampaignVanInteractionForm extends React.Component {
  state = {
    options: [],
    loaded: false
  };

  render() {
    const { campaigns } = this.props;

    !this.state.loaded &&
      campaigns.then(c =>
        this.setState({
          options: c.items,
          loaded: true
        })
      );

    const formSchema = this.props.ensureComplete
      ? yup.object(FormSchemaAfterStarted)
      : yup.object(FormSchemaBeforeStarted);

    return (
      <div>
        <CampaignFormSectionHeading title="Select the VAN Campaign to connect to" />
        <GSForm
          schema={formSchema}
          value={this.props.formValues}
          onSubmit={this.props.onSubmit}
        >
          <Autocomplete
            name="vanCampaignId"
            renderInput={params => {
              return <TextField {...params} label="Choose a campaign below" />;
            }}
            value={
              this.state.options.find(
                c => c.campaignId == this.props.formValues.vanCampaignId
              ) || ""
            }
            isOptionEqualToValue={(option, value) => {
              return option.campaignId == value.campaignId;
            }}
            onChange={(e, value) => {
              this.props.onChange({ vanCampaignId: `${value.campaignId}` });
            }}
            getOptionLabel={option => option.name}
            options={this.state.options}
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
