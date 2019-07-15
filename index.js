var AWS = require('aws-sdk');

console.log("AWS Grab Email Receipt Processor");

var defaultConfig = {
    fromEmail: "noreply@grab.com",
    subjectPrefix: "Your Grab E-Receipt",
    emailBucket: process.env.S3_BUCKET_FOR_GRAB,
    emailKeyPrefix: process.env.S3_GRAB_BUCKET_KEY
};

exports.parseEvent = function(data) {
    // Validate characteristics of a SES event record.
    if (!data.event ||
        !data.event.hasOwnProperty('Records') ||
        data.event.Records.length !== 1 ||
        !data.event.Records[0].hasOwnProperty('eventSource') ||
        data.event.Records[0].eventSource !== 'aws:ses' ||
        data.event.Records[0].eventVersion !== '1.0') {
        data.log({message: "parseEvent() received invalid SES message:",
        level: "error", event: JSON.stringify(data.event)});
        return Promise.reject(new Error('Error: Received invalid SES message.'));
    }
    
    data.email = data.event.Records[0].ses.mail;
    return Promise.resolve(data);
};

exports.fetchMessage = function (data){
    data.log({level: "info", message: "Fetching email at s3://" +
    data.config.emailBucket + '/' + data.config.emailKeyPrefix +
    data.email.messageId});

    return new Promise(function(resolve, reject){
        data.s3.getObject({
            Bucket: data.config.emailBucket,
            Key: data.config.emailKeyPrefix + data.email.messageId
          }, function(err, result) {
            if (err) {
              data.log({level: "error", message: "getObject() returned error:",
                error: err, stack: err.stack});
              return reject(
                new Error("Error: Failed to load message body from S3."));
            }
            data.emailData = result.Body.toString();
            return resolve(data);
          });
    });
};

exports.processMessage = function (data) {
    return new Promise(function(resolve, reject) {
        data.log({level: "info", message: "Processing Mail for Zapier Hook sending."});
        var email = data.emailData;

        var MailParser = require("mailparser-mit").MailParser;
        var mailparser = new MailParser();
        var h2p = require('html2plaintext');

        try {
            mailparser.on("end", async function(mail_object){
                data.log({level: "info", message: "From: " + mail_object.from[0].address});
                data.log({level: "info", message: "To: " + mail_object.to[0].address});
                data.log({level: "info", message: "Subject: " + mail_object.subject});

                var body = mail_object.html;
            
                var parsedText = h2p(body);
                data.log({level: "info", message: "ParsedText: " + parsedText});

                const jsonData = await build_json_data(parsedText);
                data.log(jsonData);
            
                const hookStatus = await postToZapier(jsonData);
                data.hookStatus = hookStatus;
            });
    
            mailparser.write(email);
            mailparser.end();        

            return resolve(data);            
        } catch (error) {
            return reject(new Error("Error: MailParser encountered an error: " + error));
        }

    });
};

exports.handler = function (event, context, callback, overrides) {
    var steps = overrides && overrides.steps ? overrides.steps :
    [
        exports.parseEvent,
        exports.fetchMessage,
        exports.processMessage
    ];

    var data = {
        event: event,
        callback: callback,
        context: context,
        config: overrides && overrides.config ? overrides.config : defaultConfig,
        log: overrides && overrides.log ? overrides.log : console.log,
        s3: overrides && overrides.s3 ?
          overrides.s3 : new AWS.S3({signatureVersion: 'v4'})
    };

    Promise.series(steps, data)
        .then(function(data) {
            data.log({level: "info", message: "Process finished successfully."});
            return data.callback();
        })
        .catch(function(err) {
            data.log({level: "error", message: "Step returned error: " + err.message,
            error: err, stack: err.stack});
            return data.callback(new Error("Error: Step returned error."));
    });
};

Promise.series = function(promises, initValue) {
    return promises.reduce(function(chain, promise) {
      if (typeof promise !== 'function') {
        return Promise.reject(new Error("Error: Invalid promise item: " +
          promise));
      }
      return chain.then(promise);
    }, Promise.resolve(initValue));
};

function get_line_item(data, line_number){
    return new Promise(function(resolve, reject){

        var lines = data.toString('utf-8').split("\n");

        if(+line_number > lines.length){
            reject('Line does not exist!');
        }

        resolve(lines[+line_number]);
    });
};

const postToZapier = async(jsonData) => {
    try {
        const got = require('got');

        const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_FOR_GRAB;
        const response = await got.post(ZAPIER_HOOK_URL, {
            body: jsonData,
            json: true
        });         
        console.log(response.body);
        return response.body;
    } catch (error) {
        console.log(error.response.body);
        return "ERROR";
    } 
};

const build_json_data = async(parsedText) => {

    var amount = await get_line_item(parsedText, 1);
    var pickup_time = await get_line_item(parsedText, 2);
    var booking_type = await get_line_item(parsedText, 3);
    var driver_name = await get_line_item(parsedText, 4);
    var passenger_name = await get_line_item(parsedText, 5);
    var booking_code = await get_line_item(parsedText, 6);
    var pickup_address = await get_line_item(parsedText, 7);
    var dropoff_address = await get_line_item(parsedText, 8);

    var jsonData = {
        amount: amount.replace(/P/g,'').replace(/\|/g,'').replace(/TIME/g,'').replace(/DATE/g,'').trim(),
        pickup_time: pickup_time.replace(/Pick-up time: /g,'').replace(/\+0800/g,'').replace(/Booking Details/g,'').replace(/Vehicle type:/g,'').trim(),
        booking_type: booking_type.replace(/Issued by driver/g,'').trim(),
        driver_name: driver_name.replace(/Issued to/g,'').trim(),
        passenger_name: passenger_name.replace(/Booking code/g,'').trim(),
        booking_code: booking_code.replace(/Pick up location:/g,'').trim(),
        pickup_address: pickup_address.replace(/Drop off location:/g,'').trim(),
        dropoff_address: dropoff_address.replace(/Tag:/g,'').replace(/Profile:/g,'').trim()
    };

    return jsonData;
};

