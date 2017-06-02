/**
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var express = require('express'); // app server
var bodyParser = require('body-parser'); // parser for post requests
var Conversation = require('watson-developer-cloud/conversation/v1'); // watson sdk
var DiscoveryV1 = require('watson-developer-cloud/discovery/v1');
var LanguageTranslator = require('watson-developer-cloud/language-translator/v2');
var ToneAnalyzerV3 = require('watson-developer-cloud/tone-analyzer/v3');

var app = express();

// Bootstrap application settings
app.use(express.static('./public')); // load UI from public folder
app.use(bodyParser.json());

// Create the service wrapper
var conversation = new Conversation({
	// If unspecified here, the CONVERSATION_USERNAME and CONVERSATION_PASSWORD env properties will be checked
	// After that, the SDK will fall back to the bluemix-provided VCAP_SERVICES environment property
	// username: '<username>',
	// password: '<password>',
	// url: 'https://gateway.watsonplatform.net/conversation/api',
	version_date: Conversation.VERSION_DATE_2017_04_21
});
var watson = require('watson-developer-cloud');

var visual_recognition = watson.visual_recognition({
	api_key: process.env.VR_API_KEY,
	version: 'v3',
	version_date: '2016-05-20'
});

var discovery = new DiscoveryV1({
	username: process.env.DISCOVERY_USERNAME,
	password: process.env.DISCOVERY_PASSWORD,
	version_date: '2016-12-01'
});

var language_translator = new LanguageTranslator({
	username: process.env.LANGUAGE_USERNAME,
	password: process.env.LANGUAGE_PASSWORD,
	version: 'v2',
	url: "https://gateway.watsonplatform.net/language-translator/api"
});

var tone_analyzer = new ToneAnalyzerV3({
	username:process.env.TONE_USERNAME,
	password: process.env.TONE_PASSWORD,
	version_date: "2016-05-19"
});

// Endpoint to be call from the client side
app.post('/api/message', function (req, res) {
	var workspace = process.env.WORKSPACE_ID || '<workspace-id>';
	if (!workspace || workspace === '<workspace-id>') {
		return res.json({
			'output': {
				'text': 'The app has not been configured with a <b>WORKSPACE_ID</b> environment variable. Please refer to the ' + '<a href="https://github.com/watson-developer-cloud/conversation-simple">README</a> documentation on how to set this variable. <br>' + 'Once a workspace has been defined the intents may be imported from ' + '<a href="https://github.com/watson-developer-cloud/conversation-simple/blob/master/training/car_workspace.json">here</a> in order to get a working application.'
			}
		});
	}

	language_translator.translate({
		text: req.body.input ? req.body.input.text : null,
		source: 'pt',
		target: 'en'
	}, function (err, translation) {

		var english = translation && translation.translations[0] ?
			translation.translations[0].translation : null;

		if (english) {
			tone_analyzer.tone({
				text: english,
				tones: "emotion"
			}, function (err, tone) {

				req.body.input.anger = tone.document_tone.tone_categories[0].tones[0].score;
				req.body.input.disgust = tone.document_tone.tone_categories[0].tones[1].score;
				req.body.input.fear = tone.document_tone.tone_categories[0].tones[2].score;
				req.body.input.joy = tone.document_tone.tone_categories[0].tones[3].score;
				req.body.input.sadness = tone.document_tone.tone_categories[0].tones[4].score;
				message(workspace, req, res);
			});

		} else {
			message(workspace, req, res);
		}

		// Send the input to the conversation service
	});
});

function message(workspace, req, res) {
	var payload = {
		workspace_id: workspace,
		context: req.body.context || {},
		input: req.body.input || {}
	};

	conversation.message(payload, function (err, data) {
		if (err) {
			return res.status(err.code || 500).json(err);
		}

		if (data.output.action && data.output.action.vr) {
			var params = {
				url: data.output.action.vr,
				classifier_ids: [process.env.VR_CLASSIFIER]
			};

			visual_recognition.classify(params, function (err, vrResult) {
				if (err)
					console.log(err);
				else {
					var classes = vrResult.images[0].classifiers.length > 0 ?
						vrResult.images[0].classifiers[0].classes
						: null;
					var payload = {
						workspace_id: workspace,
						context: data.context || {},
						input: {
							vr: classes && classes.length > 0
								? classes[0].class :
								null
						}
					};
					conversation.message(payload, function (err, data) {
						if (err) {
							return res.status(err.code || 500).json(err);
						} else {
							return res.json(updateMessage(payload, data));
						}
					})

				}
			});

		} else if (data.output.action && data.output.action.discovery) {
			discovery.query({
				environment_id: process.env.DISCOVERY_ENVIRONMENT,//process.env.ENV_WATSON_DISCOVERY_ENVIRONMENT,
				collection_id: process.env.DISCOVERY_COLLECTION,//process.env.ENV_WATSON_DISCOVERY_COLLECTION,
				query: data.output.action.discovery,
				passages: true,
				count: 5
			}, function (err, response) {
				data.output.discovery = response;
				return res.json(updateMessage(payload, data));
			});


		}
		else {
			return res.json(updateMessage(payload, data));
		}
	});
}
/**
 * Updates the response text using the intent confidence
 * @param  {Object} input The request to the Conversation service
 * @param  {Object} response The response from the Conversation service
 * @return {Object}          The response with the updated message
 */
function updateMessage(input, response) {
	var responseText = null;
	if (!response.output) {
		response.output = {};
	} else {
		return response;
	}
	if (response.intents && response.intents[0]) {
		var intent = response.intents[0];
		// Depending on the confidence of the response the app can return different messages.
		// The confidence will vary depending on how well the system is trained. The service will always try to assign
		// a class/intent to the input. If the confidence is low, then it suggests the service is unsure of the
		// user's intent . In these cases it is usually best to return a disambiguation message
		// ('I did not understand your intent, please rephrase your question', etc..)
		if (intent.confidence >= 0.75) {
			responseText = 'I understood your intent was ' + intent.intent;
		} else if (intent.confidence >= 0.5) {
			responseText = 'I think your intent was ' + intent.intent;
		} else {
			responseText = 'I did not understand your intent';
		}
	}
	response.output.text = responseText;
	return response;
}

module.exports = app;
