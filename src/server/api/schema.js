import GraphQLDate from "graphql-date";
import GraphQLJSON from "graphql-type-json";
import { GraphQLError } from "graphql/error";
import isUrl from "is-url";
import _ from "lodash";
import { gzip, makeTree, getHighestRole } from "../../lib";
import { capitalizeWord, groupCannedResponses } from "./lib/utils";
import httpRequest from "../lib/http-request";
import ownedPhoneNumber from "./lib/owned-phone-number";

import { getIngestMethod } from "../../extensions/contact-loaders";
import {
  Campaign,
  CannedResponse,
  InteractionStep,
  Invite,
  Message,
  Organization,
  Tag,
  UserOrganization,
  r,
  cacheableData
} from "../models";
import { resolvers as assignmentResolvers } from "./assignment";
import { getCampaigns, resolvers as campaignResolvers } from "./campaign";
import { resolvers as campaignContactResolvers } from "./campaign-contact";
import { resolvers as cannedResponseResolvers } from "./canned-response";
import {
  getConversations,
  getCampaignIdContactIdsMaps,
  reassignConversations,
  resolvers as conversationsResolver
} from "./conversations";
import {
  accessRequired,
  assignmentRequiredOrAdminRole,
  authRequired
} from "./errors";
import { resolvers as interactionStepResolvers } from "./interaction-step";
import { resolvers as inviteResolvers } from "./invite";
import { saveNewIncomingMessage } from "../../extensions/service-vendors/message-sending";
import {
  processServiceManagers,
  serviceManagersHaveImplementation
} from "../../extensions/service-managers";
import { getConfig, getFeatures, getTheme } from "./lib/config";
import { resolvers as messageResolvers } from "./message";
import { resolvers as optOutResolvers } from "./opt-out";
import { resolvers as organizationResolvers } from "./organization";
import { GraphQLPhone } from "./phone";
import { resolvers as questionResolvers } from "./question";
import { resolvers as questionResponseResolvers } from "./question-response";
import { resolvers as tagResolvers } from "./tag";
import { getUsers, resolvers as userResolvers } from "./user";
import { change } from "../local-auth-helpers";

import {
  bulkSendMessages,
  bulkUpdateScript,
  buyPhoneNumbers,
  deletePhoneNumbers,
  findNewCampaignContact,
  joinOrganization,
  editOrganization,
  releaseContacts,
  sendMessage,
  startCampaign,
  updateContactTags,
  updateContactCustomFields,
  updateQuestionResponses,
  releaseCampaignNumbers,
  clearCachedOrgAndExtensionCaches,
  updateFeedback,
  updateServiceManager,
  updateServiceVendorConfig
} from "./mutations";

import { jobRunner } from "../../extensions/job-runners";
import { Jobs } from "../../workers/job-processes";
import { Tasks } from "../../workers/tasks";

const uuidv4 = require("uuid").v4;

// This function determines whether a field was requested
// in a graphql query. Each graphql resolver receives a fourth parameter,
// which contains information about the current request and the execution
// context. It might be userful to determine this in order to avoid
// retrieving fields through database joins if they were not
// requested, for example.
//
// In the following query, let's say you want to test whether tags was
// included. The path to tags is conversations/conversations/contact/tags,
// because tags is in the contact object which is in the conversations
// object which is in the conversations query.
//
// Therefore, assuming the fourth parameter to your resolver is called
// 'graphqlInfo', the call to this function to determine if tags is in
// that specific position would be:
//   isFieldInSelectionSetHierarchy(graphqlInfo, ["conversations", "conversations", "contact", "tags"]);
//
// query Q(
//   $organizationId: String!
//   $cursor: OffsetLimitCursor!
//   $contactsFilter: ContactsFilter
//   $campaignsFilter: CampaignsFilter
//   $assignmentsFilter: AssignmentsFilter
//   $utc: String
// ) {
//   conversations(
//     cursor: $cursor
//     organizationId: $organizationId
//     campaignsFilter: $campaignsFilter
//     contactsFilter: $contactsFilter
//     assignmentsFilter: $assignmentsFilter
//     utc: $utc
//   ) {
//     pageInfo {
//       limit
//       offset
//       total
//     }
//     conversations {
//       texter {
//         id
//         displayName
//       }
//       contact {
//         id
//         assignmentId
//         firstName
//         lastName
//         cell
//         messageStatus
//         messages {
//           id
//           text
//           isFromContact
//         }
//         tags {
//           id
//         }
//         optOut {
//           id
//         }
//       }
//       campaign {
//         id
//         title
//       }
//     }
//   }
// }
const isFieldInSelectionSetHierarchy = (graphqlInfo, fieldPath) => {
  const findField = (selectionSet, fieldName) => {
    if (!selectionSet.selections) {
      return undefined;
    }

    return selectionSet.selections.find(
      ss =>
        ss.kind === "Field" &&
        ss.name.kind === "Name" &&
        ss.name.value === fieldName
    );
  };

  let currentLevel = graphqlInfo.operation;

  return fieldPath.every(field => {
    currentLevel = findField(currentLevel.selectionSet, field);
    return !!currentLevel;
  });
};

async function editCampaign(id, campaign, loaders, user, origCampaignRecord) {
  const {
    title,
    description,
    dueBy,
    useDynamicAssignment,
    batchSize,
    batchPolicies,
    responseWindow,
    logoImageUrl,
    introHtml,
    primaryColor,
    useOwnMessagingService,
    messageserviceSid,
    overrideOrganizationTextingHours,
    textingHoursEnforced,
    textingHoursStart,
    textingHoursEnd,
    timezone,
    vanCampaignId,
    serviceManagers
  } = campaign;
  // some changes require ADMIN and we recheck below
  const organizationId =
    campaign.organizationId || origCampaignRecord.organization_id;
  await accessRequired(
    user,
    organizationId,
    "SUPERVOLUNTEER",
    /* superadmin*/ true
  );
  const organization = await loaders.organization.load(organizationId);
  const campaignUpdates = {
    title,
    description,
    due_by: dueBy,
    use_dynamic_assignment: useDynamicAssignment,
    logo_image_url: logoImageUrl,
    primary_color: primaryColor,
    intro_html: introHtml,
    override_organization_texting_hours: overrideOrganizationTextingHours,
    texting_hours_enforced: textingHoursEnforced,
    texting_hours_start: textingHoursStart,
    texting_hours_end: textingHoursEnd,
    use_own_messaging_service: useOwnMessagingService,
    messageservice_sid: messageserviceSid,
    batch_size: batchSize,
    response_window: responseWindow,
    timezone,
    van_campaign_id: vanCampaignId
  };

  Object.keys(campaignUpdates).forEach(key => {
    if (typeof campaignUpdates[key] === "undefined") {
      delete campaignUpdates[key];
    }
  });
  if (
    user.is_superadmin &&
    campaignUpdates.description &&
    /org=\d+/.test(campaignUpdates.description)
  ) {
    // hacky org change
    campaignUpdates.organization_id = campaignUpdates.description.match(
      /org=(\d+)/
    )[1];
  }

  if (campaignUpdates.logo_image_url && !isUrl(logoImageUrl)) {
    campaignUpdates.logo_image_url = "";
  }
  if (origCampaignRecord && !origCampaignRecord.join_token) {
    campaignUpdates.join_token = uuidv4();
  }
  const features = getFeatures(origCampaignRecord);
  if (campaign.texterUIConfig && campaign.texterUIConfig.options) {
    Object.assign(features, {
      TEXTER_UI_SETTINGS: campaign.texterUIConfig.options
    });
    campaignUpdates.features = JSON.stringify(features);
  }
  if (batchPolicies) {
    Object.assign(features, {
      DYNAMICASSIGNMENT_BATCHES: batchPolicies.join(",")
    });
    campaignUpdates.features = JSON.stringify(features);
  }

  let changed = Boolean(Object.keys(campaignUpdates).length);
  if (changed) {
    await r
      .knex("campaign")
      .where("id", id)
      .update(campaignUpdates);
  }

  if (campaign.ingestMethod && campaign.contactData) {
    await accessRequired(user, organizationId, "ADMIN", /* superadmin*/ true);
    changed = true;
    const ingestMethod = await getIngestMethod(
      campaign.ingestMethod,
      organization,
      user
    );
    if (ingestMethod) {
      await jobRunner.dispatchJob({
        queue_name: `${id}:edit_campaign`,
        job_type: `ingest.${campaign.ingestMethod}`,
        locks_queue: true,
        campaign_id: id,
        payload: campaign.contactData
      });
      await r
        .knex("campaign_admin")
        .where("campaign_id", id)
        .update({
          contacts_count: null,
          ingest_method: campaign.ingestMethod,
          ingest_success: null
        });
    } else {
      console.error("ingestMethod unavailable", campaign.ingestMethod);
    }
  }

  if (campaign.hasOwnProperty("texters")) {
    changed = true;
    await jobRunner.dispatchJob({
      queue_name: `${id}:edit_campaign`,
      locks_queue: true,
      job_type: Jobs.ASSIGN_TEXTERS,
      campaign_id: id,
      payload: JSON.stringify({
        id,
        texters: campaign.texters
      })
    });
  }

  if (campaign.hasOwnProperty("interactionSteps")) {
    changed = true;
    await accessRequired(
      user,
      organizationId,
      "SUPERVOLUNTEER",
      /* superadmin*/ true
    );
    await updateInteractionSteps(
      id,
      [campaign.interactionSteps],
      origCampaignRecord
    );
    await cacheableData.campaign.clear(id);
  }

  if (campaign.hasOwnProperty("cannedResponses")) {
    changed = true;
    const cannedResponses = campaign.cannedResponses;
    const convertedResponses = [];
    for (let index = 0; index < cannedResponses.length; index++) {
      const response = cannedResponses[index];
      convertedResponses.push({
        campaign_id: id,
        id: undefined,
        title: response.title,
        text: response.text,
        tagIds: response.tagIds,
        answer_actions: response.answerActions,
        answer_actions_data: response.answerActionsData
      });
    }

    // delete canned response / tag relations from tag_canned_response
    await r.knex.transaction(async trx => {
      await trx("tag_canned_response")
        .whereIn(
          "canned_response_id",
          r
            .knex("canned_response")
            .select("id")
            .where({ campaign_id: id })
        )
        .delete();
      // delete canned responses
      await trx("canned_response")
        .where({ campaign_id: id })
        .delete();

      // save new canned responses and add their ids with related tag ids to tag_canned_response
      const saveCannedResponse = async cannedResponse => {
        const [res] = await trx("canned_response").insert(cannedResponse, [
          "id"
        ]);
        return res.id;
      };
      const tagCannedResponses = _.flatten(
        await Promise.all(
          convertedResponses.map(async response => {
            const { tagIds, ...filteredResponse } = response;
            const responseId = await saveCannedResponse(filteredResponse);
            return (tagIds || []).map(t => ({
              tag_id: t,
              canned_response_id: responseId
            }));
          })
        )
      );
      if (tagCannedResponses.length) {
        await trx("tag_canned_response").insert(tagCannedResponses);
      }
    });

    await cacheableData.cannedResponse.clearQuery({
      userId: "",
      campaignId: id
    });
  }

  const campaignRefreshed = await cacheableData.campaign.load(id, {
    forceLoad: changed
  });

  // hacky easter egg to force reload campaign contacts
  if (
    r.redis &&
    campaignUpdates.description &&
    campaignUpdates.description.endsWith("..")
  ) {
    // some asynchronous cache-priming
    console.log(
      "force-loading loadCampaignCache",
      campaignRefreshed,
      organization
    );
    await jobRunner.dispatchTask(Tasks.CAMPAIGN_START_CACHE, {
      campaign: campaignRefreshed,
      organization
    });
  }

  return Campaign.get(id);
}

async function updateInteractionSteps(
  campaignId,
  interactionSteps,
  origCampaignRecord,
  idMap = {}
) {
  for (let i = 0; i < interactionSteps.length; i++) {
    const is = interactionSteps[i];
    // map the interaction step ids for new ones
    if (idMap[is.parentInteractionId]) {
      is.parentInteractionId = idMap[is.parentInteractionId];
    }
    if (typeof is.id === "undefined") continue;
    if (is.id.indexOf("new") !== -1) {
      const newIstep = await InteractionStep.save({
        parent_interaction_id: is.parentInteractionId || null,
        question: is.questionText,
        script: is.script,
        answer_option: is.answerOption,
        answer_actions: is.answerActions,
        answer_actions_data: is.answerActionsData,
        campaign_id: campaignId,
        is_deleted: false
      });
      idMap[is.id] = newIstep.id;
    } else {
      if (
        origCampaignRecord &&
        !origCampaignRecord.is_started &&
        is.isDeleted
      ) {
        await r
          .knex("interaction_step")
          .where({ id: is.id })
          .delete();
      } else {
        await r
          .knex("interaction_step")
          .where({ id: is.id })
          .update({
            question: is.questionText,
            script: is.script,
            answer_option: is.answerOption,
            answer_actions: is.answerActions,
            answer_actions_data: is.answerActionsData,
            is_deleted: is.isDeleted
          });
      }
    }
    if (Array.isArray(is.interactionSteps) && is.interactionSteps.length) {
      await updateInteractionSteps(
        campaignId,
        is.interactionSteps,
        origCampaignRecord,
        idMap
      );
    }
  }
}

const rootMutations = {
  RootMutation: {
    bulkSendMessages,
    bulkUpdateScript,
    buyPhoneNumbers,
    deletePhoneNumbers,
    editOrganization,
    findNewCampaignContact,
    joinOrganization,
    releaseContacts,
    sendMessage,
    startCampaign,
    releaseCampaignNumbers,
    clearCachedOrgAndExtensionCaches,
    updateServiceManager,
    updateServiceVendorConfig,
    userAgreeTerms: async (_, { userId }, { user }) => {
      // We ignore userId: you can only agree to terms for yourself
      await r
        .knex("user")
        .where("id", user.id)
        .update({
          terms: true
        });
      await cacheableData.user.clearUser(user.id, user.auth0_id);
      return {
        ...user,
        terms: true
      };
    },

    updateFeedback,

    sendReply: async (_, { id, message }, { user, loaders }) => {
      const contact = await cacheableData.campaignContact.load(id);
      const campaign = await loaders.campaign.load(contact.campaign_id);

      await accessRequired(user, campaign.organization_id, "ADMIN");

      const [lastMessage] = await r
        .knex("message")
        .where("campaign_contact_id", id)
        .limit(1);

      if (!lastMessage) {
        const errorStatusAndMessage = {
          status: 400,
          message:
            "Cannot fake a reply to a contact that has no existing thread yet"
        };
        throw new GraphQLError(errorStatusAndMessage);
      }

      const userNumber = lastMessage.user_number;
      const contactNumber = contact.cell;
      const mockId = `mocked_${Math.random()
        .toString(36)
        .replace(/[^a-zA-Z1-9]+/g, "")}`;
      await saveNewIncomingMessage(
        new Message({
          contact_number: contactNumber,
          user_number: userNumber,
          is_from_contact: true,
          text: message,
          error_code: null,
          service_id: mockId,
          campaign_contact_id: contact.id,
          messageservice_sid: lastMessage.messageservice_sid,
          service: lastMessage.service,
          send_status: "DELIVERED"
        }),
        contact
      );
      return await cacheableData.campaignContact.load(id);
    },
    exportCampaign: async (_, { id }, { user, loaders }) => {
      const campaign = await loaders.campaign.load(id);
      const organizationId = campaign.organization_id;
      await accessRequired(user, organizationId, "ADMIN");
      return await jobRunner.dispatchJob({
        queue_name: `${id}:export`,
        job_type: Jobs.EXPORT,
        locks_queue: false,
        campaign_id: id,
        payload: JSON.stringify({
          id,
          requester: user.id
        })
      });
    },
    editOrganizationRoles: async (
      _,
      { userId, organizationId, roles },
      { user }
    ) => {
      const currentRoles = (
        await r
          .knex("user_organization")
          .where({
            organization_id: organizationId,
            user_id: userId
          })
          .select("role")
      ).map(res => res.role);
      const oldRoleIsOwner = currentRoles.indexOf("OWNER") !== -1;
      const newRoleIsOwner = roles.indexOf("OWNER") !== -1;
      const roleRequired = oldRoleIsOwner || newRoleIsOwner ? "OWNER" : "ADMIN";
      let newOrgRoles = [];

      await accessRequired(user, organizationId, roleRequired);

      // Roles is sent as an array for historical purposes
      // but roles are hierarchical, so we only want one user_organization
      // record. For legacy compatibility we still need to delete all recs for that user_id.
      await r
        .knex("user_organization")
        .where({ organization_id: organizationId, user_id: userId })
        .delete();
      if (roles.length) {
        const newRole = getHighestRole(roles);
        await r.knex("user_organization").insert({
          organization_id: organizationId,
          user_id: userId,
          role: newRole
        });
      }
      await cacheableData.user.clearUser(userId);
      return { id: userId };
    },
    editUser: async (_, { organizationId, userId, userData }, { user }) => {
      if (user.id !== userId) {
        // User can edit themselves
        await accessRequired(user, organizationId, "ADMIN", true);
      }
      const userRes = await r
        .knex("user")
        .join("user_organization", "user.id", "user_organization.user_id")
        .where({
          "user_organization.organization_id": organizationId,
          "user.id": userId
        })
        .limit(1);
      if (!userRes || !userRes.length) {
        return null;
      } else {
        const member = userRes[0];
        if (userData) {
          const newUserData = {
            first_name: capitalizeWord(userData.firstName).trim(),
            last_name: capitalizeWord(userData.lastName).trim(),
            alias: userData.alias
              ? capitalizeWord(userData.alias).trim()
              : null,
            email: userData.email,
            cell: userData.cell
          };
          if (member.extra || userData.extra) {
            newUserData.extra = {
              ...member.extra,
              ...JSON.parse(userData.extra || "{}")
            };
          }

          const userRes = await r
            .knex("user")
            .where("id", userId)
            .update(newUserData);
          await cacheableData.user.clearUser(member.user_id, member.auth0_id);
          userData = {
            id: userId,
            ...newUserData
          };
        } else {
          userData = member;
        }
        return userData;
      }
    },
    resetUserPassword: async (
      _,
      { organizationId, userId },
      { user, loaders }
    ) => {
      if (user.id === userId) {
        throw new Error("You can't reset your own password.");
      }
      // might need to impliment user password change available elsewhere.

      await accessRequired(user, organizationId, "ADMIN", true);

      const organization = await loaders.organization.load(organizationId);

      const passportStrategy =
        getConfig("PASSPORT_STRATEGY", organization) || "auth0";
      if (passportStrategy === "auth0") {
        const { email } = await r
          .knex("user")
          .select("email")
          .where({
            "user.id": userId
          })
          .first();

        const auth0Domain = getConfig("AUTH0_DOMAIN", organization);
        const auth0ClientID = getConfig("AUTH0_CLIENT_ID", organization);
        const url = `https://${auth0Domain}/dbconnections/change_password`;
        const body = JSON.stringify({
          client_id: auth0ClientID,
          email,
          connection: "Username-Password-Authentication"
        });
        try {
          let res = await httpRequest(url, {
            method: "POST",
            retries: 2,
            timeout: 5000,
            headers: { "Content-Type": "application/json" },
            body,
            validStatuses: [200],
            compress: false
          });
          res = await res.text();
          console.log(res, email);
          return res;
        } catch (err) {
          //handles error and sends it to the client
          throw new Error(err);
        }
      } else {
        // Add date at the end in case user record is modified after password is reset
        const passwordResetHash = uuidv4();
        const auth0_id = `reset|${passwordResetHash}|${Date.now()}`;

        const userRes = await r
          .knex("user")
          .where("id", userId)
          .update({
            auth0_id
          });
        return passwordResetHash;
      }
    },
    changeUserPassword: async (_, { userId, formData }, { user }) => {
      if (user.id !== userId) {
        throw new Error("You can only change your own password.");
      }

      const { password, newPassword, passwordConfirm } = formData;

      const updatedUser = await change({
        user,
        password,
        newPassword,
        passwordConfirm
      });

      return updatedUser;
    },
    updateTextingHours: async (
      _,
      { organizationId, textingHoursStart, textingHoursEnd },
      { user }
    ) => {
      await accessRequired(user, organizationId, "OWNER");

      await Organization.get(organizationId).update({
        texting_hours_start: textingHoursStart,
        texting_hours_end: textingHoursEnd
      });
      await cacheableData.organization.clear(organizationId);
      return await cacheableData.organization.load(organizationId);
    },
    updateTextingHoursEnforcement: async (
      _,
      { organizationId, textingHoursEnforced },
      { user }
    ) => {
      await accessRequired(user, organizationId, "SUPERVOLUNTEER");

      await Organization.get(organizationId).update({
        texting_hours_enforced: textingHoursEnforced
      });
      await cacheableData.organization.clear(organizationId);

      return await cacheableData.organization.load(organizationId);
    },
    updateOptOutMessage: async (
      _,
      { organizationId, optOutMessage },
      { user }
    ) => {
      await accessRequired(user, organizationId, "OWNER");

      const organization = await Organization.get(organizationId);
      const featuresJSON = getFeatures(organization);
      featuresJSON.opt_out_message = optOutMessage;
      organization.features = JSON.stringify(featuresJSON);

      await organization.save();
      await cacheableData.organization.clear(organizationId);

      return await Organization.get(organizationId);
    },
    updateTheme: async (
      _,
      { organizationId, primary, secondary, info, success, warning, error },
      { user }
    ) => {
      await accessRequired(user, organizationId, "OWNER");

      const organization = await Organization.get(organizationId);
      const featuresJSON = getFeatures(organization);
      featuresJSON.theme = {
        palette: {
          primary: { main: primary },
          secondary: { main: secondary },
          info: { main: info },
          success: { main: success },
          warning: { main: warning },
          error: { main: error }
        }
      };
      organization.features = JSON.stringify(featuresJSON);

      await organization.save();
      await cacheableData.organization.clear(organizationId);

      return await Organization.get(organizationId);
    },
    createInvite: async (_, { invite }, { user }) => {
      if (
        (user && user.is_superadmin) ||
        !getConfig("SUPPRESS_SELF_INVITE", null, { truthy: true })
      ) {
        const inviteInstance = new Invite({
          is_valid: invite.is_valid,
          hash: uuidv4()
        });
        const newInvite = await inviteInstance.save();
        return newInvite;
      }
    },
    createCampaign: async (_, { campaign }, { user, loaders }) => {
      await accessRequired(
        user,
        campaign.organizationId,
        "ADMIN",
        /* allowSuperadmin=*/ true
      );

      const organization = await loaders.organization.load(
        campaign.organizationId
      );

      const campaignInstance = new Campaign({
        organization_id: campaign.organizationId,
        creator_id: user.id,
        title: campaign.title,
        van_campaign_id: campaign.vanId || null,
        description: campaign.description,
        due_by: campaign.dueBy,
        is_started: false,
        is_archived: false,
        join_token: uuidv4(),
        batch_size: Number(getConfig("DEFAULT_BATCHSIZE", organization) || 300),
        response_window: getConfig("DEFAULT_RESPONSEWINDOW", organization, {
          default: 48
        }),
        use_own_messaging_service: false,
        timezone: getConfig("DST_REFERENCE_TIMEZONE", organization)
      });
      const newCampaign = await campaignInstance.save();
      await r.knex("campaign_admin").insert({
        campaign_id: newCampaign.id
      });
      return editCampaign(newCampaign.id, campaign, loaders, user);
    },
    copyCampaign: async (_, { id }, { user }) => {
      const campaign = await cacheableData.campaign.load(id);
      await accessRequired(user, campaign.organization_id, "ADMIN");

      const organization = await cacheableData.organization.load(
        campaign.organization_id
      );

      const campaignInstance = new Campaign({
        organization_id: campaign.organization_id,
        creator_id: user.id,
        title: "COPY - " + campaign.title.replace(/\s*template\W*/i, ""),
        description: campaign.description,
        due_by: campaign.due_by,
        van_campaign_id: campaign.van_campaign_id,
        features: campaign.features,
        intro_html: campaign.intro_html,
        primary_color: campaign.primary_color,
        logo_image_url: campaign.logo_image_url,
        override_organization_texting_hours:
          campaign.override_organization_texting_hours,
        texting_hours_enforced: campaign.texting_hours_enforced,
        texting_hours_start: campaign.texting_hours_start,
        texting_hours_end: campaign.texting_hours_end,
        timezone: campaign.timezone,
        use_dynamic_assignment: campaign.use_dynamic_assignment,
        batch_size:
          campaign.batch_size ||
          Number(getConfig("DEFAULT_BATCHSIZE", organization) || 300),
        response_window:
          campaign.response_window ||
          Number(getConfig("DEFAULT_RESPONSEWINDOW", organization) || 48),
        is_started: false,
        is_archived: false,
        join_token: uuidv4()
      });
      const newCampaign = await campaignInstance.save();
      await r.knex("campaign_admin").insert({
        campaign_id: newCampaign.id
      });
      const newCampaignId = newCampaign.id;
      const oldCampaignId = campaign.id;

      let interactions = await r
        .knex("interaction_step")
        .where({ campaign_id: oldCampaignId, is_deleted: false })
        .orderBy("id"); // Ensure that the copy is deterministic.

      const interactionsArr = [];
      interactions.forEach((interaction, index) => {
        if (interaction.parent_interaction_id) {
          let is = {
            id: "new" + interaction.id,
            questionText: interaction.question,
            script: interaction.script,
            answerOption: interaction.answer_option,
            answerActions: interaction.answer_actions,
            answerActionsData: interaction.answer_actions_data,
            isDeleted: interaction.is_deleted,
            campaign_id: newCampaignId,
            parentInteractionId: "new" + interaction.parent_interaction_id
          };
          interactionsArr.push(is);
        } else if (!interaction.parent_interaction_id) {
          let is = {
            id: "new" + interaction.id,
            questionText: interaction.question,
            script: interaction.script,
            answerOption: interaction.answer_option,
            answerActions: interaction.answer_actions,
            answerActionsData: interaction.answer_actions_data,
            isDeleted: interaction.is_deleted,
            campaign_id: newCampaignId,
            parentInteractionId: interaction.parent_interaction_id
          };
          interactionsArr.push(is);
        }
      });
      await updateInteractionSteps(
        newCampaignId,
        [makeTree(interactionsArr, (id = null))],
        campaign,
        {}
      );

      const originalCannedResponses = await r
        .knex("canned_response")
        .leftJoin(
          "tag_canned_response",
          "canned_response.id",
          "tag_canned_response.canned_response_id"
        )
        .where({ campaign_id: oldCampaignId })
        .select("canned_response.*", "tag_canned_response.tag_id");
      const groupedCannedResponses = groupCannedResponses(
        originalCannedResponses
      );
      const tagCannedResponses = [];
      const copiedCannedResponsePromises = groupedCannedResponses.map(
        response => {
          return r
            .knex("canned_response")
            .insert(
              {
                campaign_id: newCampaignId,
                title: response.title,
                text: response.text,
                answer_actions: response.answer_actions,
                answer_actions_data: response.answer_actions_data
              },
              ["id"]
            )
            .then(res => {
              response.tagIds.forEach(t => {
                tagCannedResponses.push({
                  canned_response_id: res[0].id,
                  tag_id: t
                });
              });
            });
        }
      );
      await Promise.all(copiedCannedResponsePromises);
      if (tagCannedResponses.length) {
        await r.knex("tag_canned_response").insert(tagCannedResponses);
      }
      return newCampaign;
    },
    unarchiveCampaign: async (_, { id }, { user }) => {
      const campaign = await cacheableData.campaign.load(id);
      await accessRequired(user, campaign.organization_id, "ADMIN");
      // TODO: make helper
      if (campaignResolvers.Campaign.isArchivedPermanently(campaign)) {
        throw new Error("Cannot archive permanently archived campaign");
      }
      campaign.is_archived = false;
      const organization = await cacheableData.organization.load(
        campaign.organization_id
      );
      await processServiceManagers("onCampaignUnarchive", organization, {
        campaign,
        user
      });
      await campaign.save();
      await cacheableData.campaign.clear(id);
      return campaign;
    },
    archiveCampaign: async (_, { id }, { user }) => {
      const campaign = await cacheableData.campaign.load(id);
      await accessRequired(user, campaign.organization_id, "ADMIN");
      campaign.is_archived = true;
      await campaign.save();
      await cacheableData.campaign.clear(id);
      if (serviceManagersHaveImplementation("onCampaignArchive")) {
        await jobRunner.dispatchTask(Tasks.SERVICE_MANAGER_TRIGGER, {
          functionName: "onCampaignArchive",
          organizationId: campaign.organization_id,
          data: {
            campaign,
            user
          }
        });
      }
      return campaign;
    },
    archiveCampaigns: async (_, { ids }, { user, loaders }) => {
      // Take advantage of the cache instead of running a DB query
      const campaigns = await Promise.all(
        ids.map(id => loaders.campaign.load(id))
      );

      await Promise.all(
        campaigns.map(campaign =>
          accessRequired(user, campaign.organization_id, "ADMIN")
        )
      );

      campaigns.forEach(campaign => {
        campaign.is_archived = true;
      });
      await Promise.all(
        campaigns.map(async campaign => {
          await campaign.save();
          await cacheableData.campaign.clear(campaign.id);
        })
      );
      loaders.campaign.clearAll();
      return campaigns;
    },
    editCampaign: async (_, { id, campaign }, { user, loaders }) => {
      const origCampaign = await Campaign.get(id);
      if (campaign.organizationId) {
        await accessRequired(user, campaign.organizationId, "ADMIN");
      } else {
        await accessRequired(
          user,
          origCampaign.organization_id,
          "SUPERVOLUNTEER"
        );
      }
      if (
        origCampaign.is_started &&
        campaign.hasOwnProperty("contacts") &&
        campaign.contacts
      ) {
        throw new GraphQLError({
          status: 400,
          message: "Not allowed to add contacts after the campaign starts"
        });
      }
      return editCampaign(id, campaign, loaders, user, origCampaign);
    },
    deleteJob: async (_, { campaignId, id }, { user }) => {
      const campaign = await Campaign.get(campaignId);
      await accessRequired(user, campaign.organization_id, "ADMIN");
      const res = await r
        .knex("job_request")
        .where({
          id,
          campaign_id: campaignId
        })
        .delete();
      return { id };
    },
    createCannedResponse: async (_, { cannedResponse }, { user }) => {
      authRequired(user);

      const cannedResponseInstance = new CannedResponse({
        campaign_id: cannedResponse.campaignId,
        user_id: cannedResponse.userId,
        title: cannedResponse.title,
        text: cannedResponse.text,
        answer_actions: cannedResponse.answerActions,
        answer_actions_data: cannedResponse.answerActionsData
      }).save();
      // deletes duplicate created canned_responses
      let query = r
        .knex("canned_response")
        .where(
          "text",
          "in",
          r
            .knex("canned_response")
            .where({
              text: cannedResponse.text,
              campaign_id: cannedResponse.campaignId
            })
            .select("text")
        )
        .andWhere({ user_id: cannedResponse.userId })
        .del();
      await query;
      await cacheableData.cannedResponse.clearQuery({
        campaignId: cannedResponse.campaignId,
        userId: cannedResponse.userId
      });
      return cannedResponseInstance;
    },
    createOrganization: async (_, { name, userId, inviteId }, { user }) => {
      authRequired(user);
      const invite = await Invite.get(inviteId);
      if (!invite || !invite.is_valid) {
        throw new GraphQLError({
          status: 400,
          message: "That invitation is no longer valid"
        });
      }

      const newOrganization = await Organization.save({
        name,
        uuid: uuidv4()
      });
      await UserOrganization.save({
        role: "OWNER",
        user_id: userId,
        organization_id: newOrganization.id
      });
      await cacheableData.user.clearUser(userId);
      await Invite.save(
        {
          id: inviteId,
          is_valid: false
        },
        { conflict: "update" }
      );

      return newOrganization;
    },
    resetOrganizationJoinLink: async (_, { organizationId }, { user }) => {
      await accessRequired(user, organizationId, "ADMIN");
      const uuid = uuidv4();
      await r
        .knex("organization")
        .where("id", organizationId)
        .update({ uuid });
      await cacheableData.organization.clear(organizationId);
      return {
        id: organizationId,
        uuid
      };
    },
    editCampaignContactMessageStatus: async (
      _,
      { messageStatus, campaignContactId, campaignIdsContactIds },
      { user }
    ) => {
      const contacts = campaignContactId
        ? [{ campaignContactId }]
        : campaignIdsContactIds;
      // this is lazy but is not likely to be done in great bulk
      console.log("editCampaignContactMessageStatus", contacts);
      await Promise.all(
        contacts.map(async ({ campaignContactId }) => {
          const contact = await cacheableData.campaignContact.load(
            campaignContactId
          );
          const organizationId = await cacheableData.campaignContact.orgId(
            contact
          );
          await assignmentRequiredOrAdminRole(
            user,
            organizationId,
            contact.assignment_id,
            contact
          );
          contact.message_status = messageStatus;
          await cacheableData.campaignContact.updateStatus(
            contact,
            messageStatus
          );
        })
      );
      return contacts.map(contact => ({
        id: contact.campaignContactId,
        message_status: messageStatus
      }));
    },
    getAssignmentContacts: async (
      _,
      { assignmentId, contactIds, findNew },
      { user, loaders }
    ) => {
      if (contactIds.length === 0) {
        return [];
      }
      const firstContact = await cacheableData.campaignContact.load(
        contactIds[0]
      );
      const organizationId = await cacheableData.campaignContact.orgId(
        firstContact
      );
      let effectiveAssignmentId = assignmentId;
      if (!effectiveAssignmentId) {
        effectiveAssignmentId = firstContact.assignment_id;
      }
      await assignmentRequiredOrAdminRole(
        user,
        organizationId,
        effectiveAssignmentId,
        firstContact
      );
      const contacts = await Promise.all(
        contactIds.map(
          // FUTURE: consider a better path for no-caching to load all ids at the same time with loadMany
          async (contactId, cIdx) =>
            cIdx === 0
              ? firstContact
              : await cacheableData.campaignContact.load(contactId)
        )
      );
      const hasAssn = contact =>
        contact &&
        Number(contact.assignment_id) === Number(effectiveAssignmentId)
          ? contact
          : null;
      const retries = contacts.filter(c => c && !hasAssn(c) && c.cachedResult);
      let updatedContacts = {};
      if (retries.length) {
        await cacheableData.campaignContact.updateCampaignAssignmentCache(
          retries[0].campaign_id,
          contactIds
        );
        const retriedContacts = await Promise.all(
          retries.map(c => cacheableData.campaignContact.load(c.id))
        );
        retriedContacts.forEach(c => {
          updatedContacts[c.id] = c;
        });
      }
      console.log("getAssignedContacts", contacts.length, updatedContacts);
      const finalContacts = contacts
        .map(c => c && (updatedContacts[c.id] || c))
        .map(hasAssn);
      if (finalContacts.length && r.redis) {
        // find out used fields so we can only send back those
        const campaign = await loaders.campaign.load(firstContact.campaign_id);
        const cannedResponses = await cacheableData.cannedResponse.query({
          campaignId: firstContact.campaign_id
        });
        if (
          campaign.usedFields &&
          (!cannedResponses.length || cannedResponses[0].usedFields)
        ) {
          const usedFields = campaign.usedFields;

          const texterSideboxes = getConfig("TEXTER_SIDEBOXES") || "";
          const shouldUseNotes = /contact-notes/.test(texterSideboxes);
          if (shouldUseNotes) usedFields.notes = 1;

          if (cannedResponses.length && cannedResponses[0].usedFields) {
            Object.keys(cannedResponses[0].usedFields).forEach(f => {
              usedFields[f] = 1;
            });
          }
          return finalContacts.map(c => (c && { ...c, usedFields }) || c);
        }
      }
      return finalContacts;
    },
    createOptOut: async (
      _,
      { optOut, campaignContactId, noReply },
      { loaders, user }
    ) => {
      const contact = await cacheableData.campaignContact.load(
        campaignContactId
      );
      const campaign = await loaders.campaign.load(contact.campaign_id);

      console.log(
        "createOptOut",
        campaignContactId,
        contact.campaign_id,
        contact.assignment_id
      );
      await assignmentRequiredOrAdminRole(
        user,
        campaign.organization_id,
        contact.assignment_id,
        contact
      );
      console.log(
        "createOptOut post access",
        campaignContactId,
        contact.campaign_id
      );
      const { assignmentId, reason } = optOut;
      const organization = await Organization.get(campaign.organization_id);
      await cacheableData.optOut.save({
        cell: contact.cell,
        campaignContactId,
        reason,
        assignmentId,
        campaign,
        noReply,
        contact,
        user,
        organization
      });
      console.log(
        "createOptOut post save",
        campaignContactId,
        contact.campaign_id
      );

      const newContact = cacheableData.campaignContact.updateCacheForOptOut(
        contact
      );
      return newContact;
    },
    deleteQuestionResponses: async (
      _,
      { interactionStepIds, campaignContactId },
      { user }
    ) => {
      const contact = await cacheableData.campaignContact.load(
        campaignContactId
      );
      const organizationId = await cacheableData.campaignContact.orgId(contact);
      await assignmentRequiredOrAdminRole(
        user,
        organizationId,
        contact.assignment_id,
        contact
      );
      // TODO: maybe undo action_handler
      await r
        .knex("question_response")
        .where("campaign_contact_id", campaignContactId)
        .whereIn("interaction_step_id", interactionStepIds)
        .delete();

      // update cache
      await cacheableData.questionResponse.reloadQuery(campaignContactId);

      return contact;
    },
    updateContactTags,
    updateContactCustomFields,
    updateQuestionResponses,
    reassignCampaignContacts: async (
      _,
      { organizationId, campaignIdsContactIds, newTexterUserId },
      { user }
    ) => {
      // verify permissions
      await accessRequired(
        user,
        organizationId,
        "SUPERVOLUNTEER",
        /* superadmin*/ true
      );

      // group contactIds by campaign
      // group messages by campaign
      const campaignIdContactIdsMap = new Map();
      for (const campaignIdContactId of campaignIdsContactIds) {
        const { campaignId, campaignContactId } = campaignIdContactId;

        if (!campaignIdContactIdsMap.has(campaignId)) {
          campaignIdContactIdsMap.set(campaignId, []);
        }

        campaignIdContactIdsMap.get(campaignId).push(campaignContactId);
      }

      return await reassignConversations(
        campaignIdContactIdsMap,
        newTexterUserId
      );
    },
    bulkReassignCampaignContacts: async (
      _,
      {
        organizationId,
        newTexterUserId,
        campaignsFilter,
        assignmentsFilter,
        contactsFilter,
        messageTextFilter
      },
      { user }
    ) => {
      // verify permissions
      await accessRequired(
        user,
        organizationId,
        "SUPERVOLUNTEER",
        /* superadmin*/ true
      );
      const { campaignIdContactIdsMap } = await getCampaignIdContactIdsMaps(
        organizationId,
        {
          campaignsFilter,
          assignmentsFilter,
          contactsFilter,
          messageTextFilter
        }
      );

      return await reassignConversations(
        campaignIdContactIdsMap,
        newTexterUserId
      );
    },
    importCampaignScript: async (_, { campaignId, url }, { user }) => {
      const campaign = await cacheableData.campaign.load(campaignId);
      await accessRequired(user, campaign.organization_id, "ADMIN", true);
      if (campaign.is_started || campaign.is_archived) {
        throw new GraphQLError(
          "Cannot import a campaign script for a campaign that is started or archived"
        );
      }

      const compressedString = await gzip(
        JSON.stringify({
          campaignId,
          url
        })
      );
      const job = await jobRunner.dispatchJob({
        queue_name: `${campaignId}:import_script`,
        job_type: Jobs.IMPORT_SCRIPT,
        locks_queue: true,
        campaign_id: campaignId,
        // NOTE: stringifying because compressedString is a binary buffer
        payload: compressedString.toString("base64")
      });

      return job.id;
    },
    createTag: async (_, { organizationId, tagData }, { user }) => {
      await accessRequired(user, organizationId, "SUPERVOLUNTEER");
      const tagInstance = new Tag({
        organization_id: organizationId,
        name: tagData.name,
        group: tagData.group,
        description: tagData.description,
        is_deleted: false
      });
      const newTag = await tagInstance.save();
      return newTag;
    },
    editTag: async (_, { organizationId, tagData, id }, { user }) => {
      await accessRequired(user, organizationId, "SUPERVOLUNTEER");
      const tagUpdates = {
        name: tagData.name,
        group: tagData.group,
        description: tagData.description,
        is_deleted: tagData.isDeleted,
        organization_id: organizationId
      };

      await r
        .knex("tag")
        .where("id", id)
        .update(tagUpdates);

      return { id, ...tagUpdates };
    },
    deleteTag: async (_, { organizationId, id }, { user }) => {
      await accessRequired(user, organizationId, "SUPERVOLUNTEER");
      await r
        .knex("tag")
        .where("id", id)
        .update({ is_deleted: true });
      return { id };
    }
  }
};

const rootResolvers = {
  Action: {
    name: o => o.name,
    displayName: o => o.displayName,
    instructions: o => o.instructions
  },
  FoundContact: {
    found: o => o.found
  },
  RootQuery: {
    campaign: async (_, { id }, { loaders, user }) => {
      const campaign = await loaders.campaign.load(id);
      await accessRequired(user, campaign.organization_id, "SUPERVOLUNTEER");
      return campaign;
    },
    assignment: async (
      _,
      { assignmentId: assignmentIdInput, contactId },
      { loaders, user }
    ) => {
      authRequired(user);
      let assignmentId = assignmentIdInput;
      if (contactId) {
        const campaignContact = await cacheableData.campaignContact.load(
          contactId
        );
        assignmentId = campaignContact.assignment_id;
      }
      if (!assignmentId) {
        return null;
      }
      const assignment = await loaders.assignment.load(assignmentId);
      if (!assignment) {
        return null;
      }
      const campaign = await loaders.campaign.load(assignment.campaign_id);
      if (assignment.user_id == user.id) {
        await accessRequired(
          user,
          campaign.organization_id,
          "TEXTER",
          /* allowSuperadmin=*/ true
        );
      } else {
        await accessRequired(
          user,
          campaign.organization_id,
          "SUPERVOLUNTEER",
          /* allowSuperadmin=*/ true
        );
      }
      return assignment;
    },
    organization: async (_, { id }, { user, loaders }) => {
      await accessRequired(user, id, "TEXTER", true);
      return await loaders.organization.load(id);
    },
    inviteByHash: async (_, { hash }, { loaders, user }) => {
      authRequired(user);
      return r.table("invite").filter({ hash });
    },
    currentUser: async (_, { id }, { user }) => {
      if (!user) {
        return null;
      } else {
        return user;
      }
    },
    organizations: async (_, { id }, { user }) => {
      if (user.is_superadmin) {
        return r.table("organization").orderBy("id");
      } else {
        return await cacheableData.user.userOrgs(user.id, "TEXTER");
      }
    },
    conversations: async (
      _,
      {
        cursor,
        organizationId,
        campaignsFilter,
        assignmentsFilter,
        contactsFilter,
        messageTextFilter,
        utc
      },
      { user },
      graphqlInfo
    ) => {
      // Determine if tags were requested in the graphql query.
      // in order to avoid retrieving tags if they were not
      // requested.
      const includeTags = isFieldInSelectionSetHierarchy(graphqlInfo, [
        "conversations",
        "conversations",
        "contact",
        "tags"
      ]);

      await accessRequired(user, organizationId, "SUPERVOLUNTEER", true);
      const data = await getConversations(
        cursor,
        organizationId,
        {
          campaignsFilter,
          assignmentsFilter,
          contactsFilter,
          messageTextFilter
        },
        utc,
        includeTags
      );
      return data;
    },
    campaigns: async (
      _,
      { organizationId, cursor, campaignsFilter },
      { user }
    ) => {
      await accessRequired(user, organizationId, "SUPERVOLUNTEER");
      return getCampaigns(organizationId, cursor, campaignsFilter);
    },
    people: async (
      _,
      {
        organizationId,
        cursor,
        campaignsFilter,
        role,
        sortBy,
        filterString,
        filterBy
      },
      { user }
    ) => {
      await accessRequired(user, organizationId, "SUPERVOLUNTEER");
      return getUsers(
        organizationId,
        cursor,
        campaignsFilter,
        role,
        sortBy,
        filterString,
        filterBy
      );
    },
    user: async (_, { organizationId, userId }, { user }) => {
      // This is somewhat redundant to people and getCurrentUser above
      if (user && !userId) {
        return user;
      } else if (user.id !== userId) {
        // User can view themselves
        await accessRequired(user, organizationId, "ADMIN", true);
      }
      // TODO: use caching+loaders and possibly move into organization
      return r
        .knex("user")
        .join("user_organization", "user.id", "user_organization.user_id")
        .where({
          "user_organization.organization_id": organizationId,
          "user.id": userId
        })
        .select(
          "user_organization.organization_id",
          "user_organization.role",
          "user.*"
        )
        .first();
    }
  }
};

export const resolvers = {
  ...rootResolvers,
  ...userResolvers,
  ...organizationResolvers,
  ...campaignResolvers,
  ...assignmentResolvers,
  ...interactionStepResolvers,
  ...optOutResolvers,
  ...messageResolvers,
  ...campaignContactResolvers,
  ...cannedResponseResolvers,
  ...questionResponseResolvers,
  ...inviteResolvers,
  ...{ Date: GraphQLDate },
  ...{ JSON: GraphQLJSON },
  ...{ Phone: GraphQLPhone },
  ...questionResolvers,
  ...conversationsResolver,
  ...tagResolvers,
  ...rootMutations
};
