// Add actions columns to canned_response
exports.up = function(knex) {
  return knex.schema.alterTable("campaign", table => {
    table.text("van_campaign_id").nullable();
  });
};

// Drop actions columns from canned_response
exports.down = function(knex) {
  return knex.schema.alterTable("campaign", table => {
    table.dropColumn("van_campaign_id");
  });
};
