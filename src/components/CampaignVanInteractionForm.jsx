import PropTypes from "prop-types";
import React from "react";
import Form from "react-formal";
import moment from "moment";
import CampaignFormSectionHeading from "./CampaignFormSectionHeading";
import GSForm from "./forms/GSForm";
import GSColorPicker from "./forms/GSColorPicker";
import GSTextField from "./forms/GSTextField";
import GSDateField from "./forms/GSDateField";
import GSSubmitButton from "./forms/GSSubmitButton";
import * as yup from "yup";
import { dataTest } from "../lib/attributes";
import { Autocomplete } from "@material-ui/lab";
import { TextField } from "@material-ui/core";

// TODO
// Update schema
// Write autocomplete function
// Pull VAN API in
// Make it only appear when VAN API keys are set

const FormSchemaBeforeStarted = {
  title: yup.string().required(),
  description: yup
    .string()
    .optional()
    .default("No description provided"),
  dueBy: yup
    .mixed()
    .required()
    .test(
      "in-future",
      "Due date should be in the future: when you expect the campaign to end",
      val => new Date(val) > new Date()
    ),
  logoImageUrl: yup
    .string()
    .url()
    .transform(value => (!value ? null : value))
    .nullable(),
  primaryColor: yup.string().nullable(),
  introHtml: yup.string().nullable()
};

const FormSchemaAfterStarted = {
  title: yup.string().required(),
  description: yup
    .string()
    .optional()
    .default("No description provided"),
  dueBy: yup.mixed().required(),
  logoImageUrl: yup
    .string()
    .transform(value => (!value ? null : value))
    .url()
    .nullable(),
  primaryColor: yup
    .string()
    .matches(/^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/)
    .transform(value => (!value ? null : value))
    .nullable(),
  introHtml: yup
    .string()
    .transform(value => (!value ? null : value))
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
  formSchema() {
    if (this.props.ensureComplete) {
      // i.e. campaign.isStarted
      return yup.object(FormSchemaAfterStarted);
    }
    return yup.object(FormSchemaBeforeStarted);
  }

  render() {
    const formSchema = this.formSchema();

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
          {/* <Form.Field
            as={GSTextField}
            {...dataTest("title")}
            name="title"
            label="Title (required)"
            helpertext="e.g. Election Day 2016"
            fullWidth
          />
          <Form.Field
            as={GSTextField}
            {...dataTest("description")}
            name="description"
            label="Description"
            helpertext="Get out the vote"
            fullWidth
          />
          <Form.Field
            as={GSDateField}
            {...dataTest("dueBy")}
            name="dueBy"
            label="Due date (required)"
            locale="en-US"
            shouldDisableDate={date => moment(date).diff(moment()) < 0}
            fullWidth
          />
          <Form.Field
            as={GSTextField}
            name="introHtml"
            label="Intro HTML"
            multiline
            fullWidth
          />
          <Form.Field
            as={GSTextField}
            name="logoImageUrl"
            label="Logo Image URL"
            helpertext="https://www.mysite.com/images/logo.png"
            fullWidth
          />
          <Form.Field
            as={GSColorPicker}
            name="primaryColor"
            label="Primary color"
          /> */}
          <Autocomplete
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
    title: PropTypes.string,
    description: PropTypes.string,
    dueBy: PropTypes.any,
    logoImageUrl: PropTypes.string,
    primaryColor: PropTypes.string,
    introHtml: PropTypes.string
  }),
  onChange: PropTypes.func,
  onSubmit: PropTypes.func,
  saveLabel: PropTypes.string,
  saveDisabled: PropTypes.bool,
  ensureComplete: PropTypes.bool
};
