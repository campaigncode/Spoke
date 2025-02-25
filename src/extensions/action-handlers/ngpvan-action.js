import { getConfig, hasConfig } from "../../server/api/lib/config";
import Van from "../contact-loaders/ngpvan/util";
import {
  getCountryCode,
  getDashedPhoneNumberDisplay
} from "../../lib/phone-format";
import httpRequest from "../../server/lib/http-request.js";

export const name = "ngpvan-action";

// What the user sees as the option
export const displayName = () => "NGPVAN action";

// The Help text for the user after selecting the action
export const instructions = () =>
  `
  This action is for reporting the results of interactions with contacts to NGPVAN
  `;

export function serverAdministratorInstructions() {
  return {
    description:
      "This action is for reporting the results of interactions with contacts to NGPVAN",
    setupInstructions:
      "Get an APP name and API key for your VAN account. Add them to your config, along with NGP_VAN_WEBHOOK_BASE_URL. In most cases the defaults for the other environment variables will work",
    environmentVariables: [
      "NGP_VAN_API_KEY",
      "NGP_VAN_API_BASE_URL",
      "NGP_VAN_APP_NAME",
      "NGP_VAN_ACTION_HANDLER_CACHE_TTL"
    ]
  };
}

export const DEFAULT_NGP_VAN_CONTACT_TYPE = "SMS Text";
export const DEFAULT_NGP_VAN_INPUT_TYPE = "API";
export const DEFAULT_NGP_VAN_ACTION_HANDLER_CACHE_TTL = 600;

export function clientChoiceDataCacheKey() {
  return "";
}

export const postCanvassResponse = async (contact, organization, bodyInput) => {
  console.log(contact, organization, bodyInput);
  let vanId;
  let vanPhoneId;
  try {
    const customFields = JSON.parse(contact.custom_fields || "{}");
    vanId = customFields.VanID || customFields.vanid;
    vanPhoneId = customFields.VanPhoneId || customFields.vanPhoneId;
  } catch (caughtException) {
    // eslint-disable-next-line no-console
    console.error(
      `Error parsing custom_fields for contact ${contact.id} ${caughtException}`
    );
    return {};
  }

  if (!vanId) {
    // eslint-disable-next-line no-console
    console.error(
      `Cannot sync results to van for campaign_contact ${contact.id}. No VanID in custom fields`
    );
    return {};
  }

  const body = {
    ...bodyInput
  };

  if (contact.cell) {
    const phoneCountry = process.env.PHONE_NUMBER_COUNTRY || "US";

    body.canvassContext.phone = {
      dialingPrefix: getCountryCode(contact.cell, phoneCountry).toString(),
      phoneNumber: getDashedPhoneNumberDisplay(contact.cell, phoneCountry)
    };
  }

  if (vanPhoneId) {
    body.canvassContext.phoneId = vanPhoneId;
  }

  const url = Van.makeUrl(`v4/people/${vanId}/canvassResponses`, organization);

  // eslint-disable-next-line no-console
  console.info("Sending contact update to VAN", {
    vanId,
    body: JSON.stringify(body)
  });

  return httpRequest(url, {
    method: "POST",
    retries: 0,
    timeout: Van.getNgpVanTimeout(organization),
    headers: {
      Authorization: await Van.getAuth(organization),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    validStatuses: [204],
    compress: false
  });
};

// What happens when a texter saves the answer that triggers the action
// This is presumably the meat of the action
export async function processAction({ actionObject, contact, organization }) {
  try {
    const answerActionsData = JSON.parse(
      (actionObject || {}).answer_actions_data || "{}"
    );

    const body = JSON.parse(answerActionsData.value);

    return postCanvassResponse(contact, organization, body);
  } catch (caughtError) {
    // eslint-disable-next-line no-console
    console.error("Encountered exception in ngpvan.processAction", caughtError);
    throw caughtError;
  }
}

async function getContactTypeIdAndInputTypeId(organization) {
  const contactTypesPromise = httpRequest(
    Van.makeUrl(`v4/canvassResponses/contactTypes`),
    {
      method: "GET",
      timeout: Van.getNgpVanTimeout(organization),
      headers: {
        Authorization: await Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving contact types from VAN ${error}`;
      // eslint-disable-next-line no-console
      console.error(message);
      throw new Error(message);
    });

  const inputTypesPromise = httpRequest(
    Van.makeUrl(`v4/canvassResponses/inputTypes`),
    {
      method: "GET",
      timeout: Van.getNgpVanTimeout(organization),
      headers: {
        Authorization: await Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving input types from VAN ${error}`;
      // eslint-disable-next-line no-console
      console.error(message);
      throw new Error(message);
    });

  let contactTypeId;
  let inputTypeId;

  try {
    const [contactTypesResponse, inputTypesResponse] = await Promise.all([
      contactTypesPromise,
      inputTypesPromise
    ]);

    const contactType =
      getConfig("NGP_VAN_CONTACT_TYPE", organization) ||
      DEFAULT_NGP_VAN_CONTACT_TYPE;
    ({ contactTypeId } = contactTypesResponse.find(
      ct => ct.name === contactType
    ));
    if (!contactTypeId) {
      // eslint-disable-next-line no-console
      console.error(`Contact type ${contactType} not returned by VAN`);
    }

    const inputTypeName = getConfig("NGP_VAN_INPUT_TYPE", organization);
    if (inputTypeName) {
      const inputType =
        inputTypesResponse.find(inTy => inTy.name === inputTypeName) || {};
      inputTypeId = inputType.inputTypeId || -1;
      if (inputTypeId === -1) {
        // eslint-disable-next-line no-console
        console.error(`Input type ${inputType} not returned by VAN`);
      }
    }

    if (inputTypeId === -1 || !contactTypeId) {
      throw new Error(
        "VAN did not return the configured input type or contact type. Check the log"
      );
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `Error loading canvass/contactTypes or canvass/inputTypes from VAN  ${error}`
    );
  }

  return { contactTypeId, inputTypeId };
}

export async function getClientChoiceData(organization) {
  const { contactTypeId, inputTypeId } = await getContactTypeIdAndInputTypeId(
    organization
  );

  if (inputTypeId === -1 || !contactTypeId) {
    return {
      data: `${JSON.stringify({
        error:
          "Failed to load canvass/contactTypes or canvass/inputTypes from VAN"
      })}`
    };
  }

  const canvassContext = { contactTypeId };
  if (inputTypeId) canvassContext.inputTypeId = inputTypeId;

  const cycle = await getConfig("NGP_VAN_ELECTION_CYCLE_FILTER", organization);
  const cycleFilter = (cycle && `&cycle=${cycle}`) || "";
  const surveyQuestionsPromise = httpRequest(
    Van.makeUrl(`v4/surveyQuestions?statuses=Active${cycleFilter}&$top=200`),
    {
      method: "GET",
      timeout: Van.getNgpVanTimeout(organization),
      headers: {
        Authorization: await Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving survey questions from VAN ${error}`;
      // eslint-disable-next-line no-console
      console.error(message);
      throw new Error(message);
    });

  const activistCodesPromise = httpRequest(
    Van.makeUrl(`v4/activistCodes?statuses=Active&$top=200`),
    {
      method: "GET",
      timeout: Van.getNgpVanTimeout(organization),
      headers: {
        Authorization: await Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving activist codes from VAN ${error}`;
      // eslint-disable-next-line no-console
      console.error(message);
      throw new Error(message);
    });

  const canvassResultCodesPromise = httpRequest(
    Van.makeUrl(`v4/canvassResponses/resultCodes?$top=200`),
    {
      method: "GET",
      timeout: Van.getNgpVanTimeout(organization),
      headers: {
        Authorization: await Van.getAuth(organization)
      }
    }
  )
    .then(async response => await response.json())
    .catch(error => {
      const message = `Error retrieving canvass result codes from VAN ${error}`;
      // eslint-disable-next-line no-console
      console.error(message);
      throw new Error(message);
    });

  let surveyQuestionsResponse;
  let activistCodesResponse;
  let canvassResponsesResultCodesResponse;

  try {
    [
      surveyQuestionsResponse,
      activistCodesResponse,
      canvassResponsesResultCodesResponse
    ] = await Promise.all([
      surveyQuestionsPromise,
      activistCodesPromise,
      canvassResultCodesPromise
    ]);
  } catch (caughtError) {
    // eslint-disable-next-line no-console
    console.error(
      `Error loading surveyQuestions, activistCodes or canvass/resultCodes from VAN  ${caughtError}`
    );
    return {
      data: `${JSON.stringify({
        error:
          "Failed to load surveyQuestions, activistCodes or canvass/resultCodes from VAN"
      })}`
    };
  }

  const buildPayload = responseBody =>
    JSON.stringify({
      canvassContext: {
        ...canvassContext
      },
      ...responseBody
    });

  const surveyResponses = surveyQuestionsResponse.items.reduce(
    (accumulator, surveyQuestion) => {
      const responses = surveyQuestion.responses.map(surveyResponse => ({
        name: `${surveyQuestion.name} - ${surveyResponse.name}`,
        details: buildPayload({
          responses: [
            {
              type: "SurveyResponse",
              surveyQuestionId: surveyQuestion.surveyQuestionId,
              surveyResponseId: surveyResponse.surveyResponseId
            }
          ]
        })
      }));
      accumulator.push(...responses);
      return accumulator;
    },
    []
  );

  const activistCodes = activistCodesResponse.items.map(activistCode => ({
    name: activistCode.name,
    details: buildPayload({
      responses: [
        {
          type: "ActivistCode",
          action: "Apply",
          activistCodeId: activistCode.activistCodeId
        }
      ]
    })
  }));

  const canvassResponses = canvassResponsesResultCodesResponse.map(
    canvassResponse => ({
      name: canvassResponse.name,
      details: buildPayload({
        resultCodeId: canvassResponse.resultCodeId
      })
    })
  );

  const vanActions = [
    ...surveyResponses,
    ...activistCodes,
    ...canvassResponses
  ];

  return {
    data: `${JSON.stringify({ items: vanActions })}`,
    expiresSeconds:
      Number(getConfig("NGP_VAN_ACTION_HANDLER_CACHE_TTL", organization)) ||
      DEFAULT_NGP_VAN_ACTION_HANDLER_CACHE_TTL
  };
}

// return true, if the action is usable and available for the organizationId
// Sometimes this means certain variables/credentials must be setup
// either in environment variables or organization.features json data
// Besides this returning true, "test-action" will also need to be added to
// process.env.ACTION_HANDLERS
export async function available(organization) {
  let result =
    (hasConfig("NGP_VAN_API_KEY", organization) ||
      hasConfig("NGP_VAN_API_KEY_ENCRYPTED", organization)) &&
    hasConfig("NGP_VAN_APP_NAME", organization);

  if (!result) {
    // eslint-disable-next-line no-console
    console.info(
      "ngpvan-action unavailable. Missing one or more required environment variables"
    );
  }

  if (result) {
    try {
      const { data } = await exports.getClientChoiceData(organization);
      const parsedData = (data && JSON.parse(data)) || {};
      if (parsedData.error) {
        // eslint-disable-next-line no-console
        console.info(
          `ngpvan-action unavailable. getClientChoiceData returned error ${parsedData.error}`
        );
        result = false;
      }
    } catch (caughtError) {
      // eslint-disable-next-line no-console
      console.info(
        `ngpvan-action unavailable. getClientChoiceData threw an exception ${caughtError}`
      );
      result = false;
    }
  }

  return {
    result,
    expiresSeconds: 86400
  };
}
