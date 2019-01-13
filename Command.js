/**
 * @author Multivitamin <david.kartnaller@gmail.com>
 * @license MIT
 * @ignore
 */
registerPlugin({
  name: "Command",
  description: "Library to handle and manage Commands",
  version: "1.0",
  author: "Multivitamin <david.kartnaller@gmail.com>",
  autorun: true,
  backends: ["ts3", "discord"],
  vars: [{
    name: "NOT_FOUND_MESSAGE",
    title: "Send a message if no command has been found?",
    type: "select",
    options: ["YES", "NO"],
    default: "0"
  }, {
    name: "DEBUGLEVEL",
    title: "Debug Messages (default is INFO)",
    type: "select",
    options: ["ERROR", "WARNING", "INFO", "VERBOSE"],
    default: "2"
  }]
}, (_, config) => {

  const engine = require("engine")
  const event = require("event")
  const backend = require("backend")
  const format = require("format")
  var commands = []

  function DEBUG(level) {
    return mode => (...args) => {
      if (mode > level) return
      engine.log(...args)
    }
  }
  DEBUG.VERBOSE = 3
  DEBUG.INFO = 2
  DEBUG.WARNING = 1
  DEBUG.ERROR = 0
  const debug = DEBUG(parseInt(config.DEBUGLEVEL, 10))

  const GROUP_ARGS = {
    OR: "or",
    AND: "and"
  }

  debug(DEBUG.INFO)(`command prefix is "${getCommandPrefix()}"`)

  /**
   * Class representing a ParseError
   * @private
   * @extends Error
   */
  class ParseError extends Error {
    constructor(err) {
      super(err)
    }
  }


  /** 
   * Class representing an Argument
   * @name Argument
   */
  class Argument {
    constructor() {
      this._optional = false
      this._name = "_"
      this._display = "_"
      this._default = undefined
    }

    /**
     * Sets an Argument as optional
     * @param {any} [fallback] - the default value which should be set if this parameter has not been found
     * @returns {Argument} returns this to chain functions
     */
    optional(fallback) {
      this._default = fallback
      this._optional = true
      return this
    }

    /**
     * Retrieves the default value if it had been set
     * @returns {any} the default value of this argument
     */
    getDefault() {
      return this._default
    }

    /**
     * Checks if the Argument has a default value
     * @returns {boolean} returns true when a default value is present
     */
    hasDefault() {
      return this._default !== undefined
    }

    /**
     * Gets the manual of a command
     * @returns {string} will return a formated name
     */
    getManual() {
      if (this.isOptional()) {
        return `[${this._display}${this.hasDefault() ? `=${this.getDefault()}`: ""}]`
      } else {
        return `<${this._display}>`
      }
    }

    /**
     * Checks if the Argument is optional
     * @returns {Boolean} returns true when the current Argument is optional
     */
    isOptional() {
      return this._optional
    }

    /**
     * Sets a name for the argument to identify it later when the Command gets dispatched
     * @param {string} name - sets the name of the argument
     * @param {string} [display] - sets a beautified display name which will be used when the getManual command gets executed, if none given it will use the first parameter as display value
     * @returns {Argument} returns this to make functions chainable
     */
    setName(name, display = false) {
      this._display = display
      if (this._display === false) this._display = name
      if (typeof name !== "string") throw new Error("Argument of setName needs to be a string")
      if (name.length < 1) throw new Error("Argument of setName needs to be at least 1 char long")
      if (!name.match(/^[a-z0-9_]+$/i)) throw new Error("Argument of setName should contain only chars A-z, 0-9 and _")
      this._name = name
      return this
    }

     /**
      * Retrieves the name of the Argument
      * @returns {string} retrieves the arguments name
      */
     getName() {
       return this._name
     }
  }


  /** 
   * Class representing a GroupArgument
   * @name GroupArgument
   * @extends Argument
   * @param {string} type - the type of the Argument, should be "and" or "or"
   */
  class GroupArgument extends Argument {
    constructor(type) {
      super()
      this._type = type
      this._args = []
    }

    /**
     * Validates the given String to the GroupArgument
     * @private
     * @param {string} args - the remaining args
     * @returns {Error|Array} returns an Error if the validation failed or the resolved arg as first index and the remaining args as second index
     */
    validate(args) {
      switch (this._type) {
        case GROUP_ARGS.OR: return this._validateOr(args)
        case GROUP_ARGS.AND: return this._validateAnd(args)
      }
    }

    /**
     * Validates the given string to the "or" of the GroupArgument
     * @private
     * @param {string} args - the remaining args
     * @returns {Error|Array} returns an Error if the validation failed or the resolved arg as first index and the remaining args as second index
     */
    _validateOr(args) {
      var errors = []
      var resolved = {}
      var valid = this._args.some(arg => {
        var result = arg.validate(args)
        if (result instanceof Error)
          return (errors.push(result), false)
        resolved[arg.getName()] = result[0]
        return (args = result[1].trim(), true)
      })
      if (!valid) return Error(`No valid match found`)
      return [resolved, args]
    }

    /**
     * Validates the given string to the "and" of the GroupArgument
     * @private
     * @param {string} args - the remaining args
     * @returns {Error|Array} returns an Error if the validation failed or the resolved arg as first index and the remaining args as second index
     */
    _validateAnd(args) {
      var resolved = {}
      var error = null
      this._args.some(arg => {
        var result = arg.validate(args)
        if (result instanceof Error) return (error = result, true)
        resolved[arg.getName()] = result[0]
        return (args = result[1].trim(), false)
      })
      if (error !== null) return error
      return [resolved, args]
    }

    /**
     * Adds one or multiple argument to the validation chain
     * @param {string} args - the remaining args
     * @returns {this} returns this to make it chainable
     */
    argument(...args) {
      this._args.push(...args)
      return this
    }
  }



  /** 
   * Class representing a StringArgument
   * @name StringArgument
   * @extends Argument
   */
  class StringArgument extends Argument {
    constructor(ignoreWhitespace = false) {
      super()
      super._parent = this
      this._regex = null
      this._maxlen = null
      this._minlen = null
      this._whitelist = null
      this._uppercase = false
      this._lowercase = false
    }

    /**
     * Validates the given String to the StringArgument
     * @private
     * @param {string} args - the remaining args       
     * @returns {Error|Array} returns an Error if the validation failed or the resolved arg as first index and the remaining args as second index
     */
    validate(args) {
      var argArray = args.split(" ")
      var str = argArray.shift()
      return this._validate(str, argArray.join(" "))
    }

    /**
     * Validates the given string to the StringArgument params
     * @private
     * @param {string} args - args which should get parsed
     * @param {string} rest - the remaining args
     * @returns {Error|boolean} returns true when validation was successful otherwise returns an Error
     */
    _validate(str, ...rest) {
      if (typeof str !== "string") return new ParseError(`Given input is not typeof string (typeof ${typeof str})`)
      if (this._uppercase) str = str.toUpperCase()
      if (this._lowercase) str = str.toLowerCase()
      if (this._minlen !== null && this._minlen > str.length) return new ParseError(`String length not greater or equal! Expected at least ${this._minlen}, but got ${str.length}`)
      if (this._maxlen !== null && this._maxlen < str.length) return new ParseError(`String length not less or equal! Maximum ${this._maxlen} chars allowed, but got ${str.length}`)
      if (this._whitelist !== null && this._whitelist.indexOf(str) === -1) return new ParseError(`Invalid Input for ${str}. Allowed words: ${this._whitelist.join(", ")}`)
      if (this._regex !== null && !this._regex.test(str)) return new ParseError(`Regex missmatch, the input '${str}' did not match the expression ${this._regex.toString()}`)
      return [str, ...rest]
    }

    /**
     * Matches a regular expression pattern
     * @param {RegExp} regex the regex which should be validated
     * @returns {StringArgument} returns this to chain Functions
     */
    match(regex) {
      this._regex = regex
      return this
    }

    /**
     * Sets the maximum Length of the String
     * @param {number} len - the maximum length of the argument
     * @returns {StringArgument} returns this to chain Functions
     */
    max(len) {
      this._maxlen = len
      return this
    }

    /**
     * Sets the minimum Length of the String
     * @param {number} len - the minimum length of the argument
     * @returns {StringArgument} returns this to chain Functions
     */
    min(len) {
      this._minlen = len
      return this
    }


    /**
     * Converts the input to an upper case string
     * @returns {StringArgument} returns this to chain Functions
     */
    forceUpperCase() {
      this._lowercase = false
      this._uppercase = true
      return this
    }


    /**
     * Converts the input to a lower case string
     * @returns {StringArgument} returns this to chain Functions
     */
    forceLowerCase() {
      this._lowercase = true
      this._uppercase = false
      return this
    }

    /**
     * Creates a list of available whitelisted words
     * @param {array} words - array of whitelisted words
     * @returns {StringArgument} returns this to chain Functions
     */
    whitelist(words) {
      if (!Array.isArray(this._whitelist)) this._whitelist = []
      this._whitelist.push(...words)
      return this
    }
  }



  /** 
   * Class representing a ClientArgument
   * @name ClientArgument
   * @extends Argument
   */
  class ClientArgument extends Argument {
    constructor() {
      super()
      super._parent = this
    }

    /**
     * Validates and tries to parse the Client from the given input string
     * @private
     * @param {string} args - the input from where the client gets extracted
     * @returns {Error|Array} returns an Error if the validation failed or the resolved arg as first index and the remaining args as second index
     */
    validate(args) {
      var match = args.match(/^(\[URL=client:\/\/\d*\/(?<url_uid>[\/+a-z0-9]{27}=)~.*\].*\[\/URL\]|(?<uid>[\/+a-z0-9]{27}=)) *(?<rest>.*)$/i)
      if (!match) return new ParseError("Client not found!")
      return [match.groups.url_uid||match.groups.uid, match.groups.rest]
    }
  }



  /** 
   * Class representing a RestArgument
   * @name RestArgument
   * @extends StringArgument
   */
  class RestArgument extends StringArgument {
    constructor() {
      super()
    }

    /**
     * Validates the given String to the RestArgument
     * @private
     * @param {string} args - the remaining args       
     * @returns {Error|Array} returns an Error if the validation failed or the resolved arg as first index and the remaining args as second index
     */
    validate(args) {
      return super._validate(args, "")
    }
  }




  /** 
   * Class representing a NumberArgument
   * @name NumberArgument
   * @extends Argument
   */
  class NumberArgument extends Argument {
    constructor() {
      super()
      super._parent = this
      this._min = null
      this._max = null
      this._integer = false
      this._forcePositive = false
      this._forceNegative = false
    }

    /**
     * Validates the given Number to the Object
     * @private
     * @param {string} args - the remaining args
     * @returns {Error|Array} returns an Error if the validation failed or the resolved arg as first index and the remaining args as second index
     */
    validate(args) {
      var argArray = args.split(" ")
      var num = argArray.shift()
      if (isNaN(num)) return new ParseError(`Searched for number but found "${num}"`)
      num = parseFloat(num)
      if (isNaN(num)) return new ParseError(`Given input is not typeof Number (typeof ${typeof num})`)
      if (this._min !== null && this._min > num) return new ParseError(`Number not greater or equal! Expected at least ${this._min}, but got ${num}`)
      if (this._max !== null && this._max < num) return new ParseError(`Number not less or equal! Expected at least ${this._max}, but got ${num}`)
      if (this._integer && num % 1 !== 0) return new ParseError(`Given Number is not an Integer! (${num})`)
      if (this._forcePositive && num <= 0) return new ParseError(`Given Number is not Positive! (${num})`)
      if (this._forceNegative && num >= 0) return new ParseError(`Given Number is not Negative! (${num})`)
      return [num, argArray.join(" ")]
    }

    /**
     * Specifies the minimum value
     * @param {number} len - the maximum length of the argument
     * @returns {NumberArgument} returns this to chain Functions
     */
    min(min) {
      this._min = min
      return this
    }

    /**
     * Specifies the maximum value
     * @param {number} len - the maximum length of the argument
     * @returns {NumberArgument} returns this to chain Functions
     */
    max(max) {
      this._max = max
      return this
    }

    /**
     * Specifies that the Number must be an integer (no floating point)
     * @returns {NumberArgument} returns this to chain Functions
     */
     integer() {
       this._integer = true
       return this
     }

     /**
      * Specifies that the Number must be a positive Number
      * @returns {NumberArgument} returns this to chain Functions
      */
     positive() {
       this._forcePositive = true
       this._forceNegative = false
       return this
     }

     /**
      * Specifies that the Number must be a negative Number
      * @returns {NumberArgument} returns this to chain Functions
      */
     negative() {
       this._forcePositive = false
       this._forceNegative = true
       return this
     }

  }



  const availableArguments = {
    string: () => new StringArgument(),
    number: () => new NumberArgument(),
    client: () => new ClientArgument(),
    rest: () => new RestArgument()
  }



  /** 
   * Class representing a Command
   * @name Command
    * @param {string} cmd - The Command which should be used
    */
  class Command {
    constructor(cmd) {
      this._validateCommand(cmd)
      this._cmd = cmd
      this._help = ""
      this._manual = []
      this._enabled = true
      this._fncs = {}
      this._alias = []
      this._args = []
    }

    /**
     * Validates a Command and check if its okay to use
     * @private
     * @param {any} cmd - the command which should be tested for
     * @param {boolean} [throwException = true] - wether it should throw an exception or not
     * @returns {boolean} - the validation result
     */
    _validateCommand(cmd, throwException = true) {
      if (typeof cmd === "string" && cmd.length > 0) return true
      if (throwException) throw new Error("Command needs to be at least 1 char long!")
      return false
    }

    /**
     * Searches and returns the given function name
     * @private
     * @param {string} name - the function name which should be searched for
     * @param {function} [fallback] - returns a fallback function if no function under the name has been found
     * @returns {function} - the stored function
     */
    _getFunction(name, fallback = () => true) {
      if (typeof this._fncs[name] === "function") return this._fncs[name]
      return fallback
    }

    /**
     * Stores a function with the given name, can be used to overwrite a function
     * @private
     * @param {string} name - the name for which the function should be stored
     * @param {function} [fnc] - the function which should be stored
     * @returns {Command} returns this to chain Functions
     */
    _storeFunction(name, fnc = () => true) {
      if (typeof fnc !== "function") throw new Error("Parameter is no a function!")
      this._fncs[name] = fnc
      return this
    }

    /**
     * Retrieves the serialized data from a command
     */
    serialize() {
      return JSON.stringify({
        cmd: this._cmd,
        alias: this._alias,
        help: this._help,
        manual: this._manual
      })
    }

    /**
     * Disabled the command
     * @returns {Command} returns this to chain Functions
     */
    disable() {
      debug(DEBUG.INFO)(`Command "${this.getCommand()}" has been disabled`)
      this._enabled = false
      return this
    }

    /**
     * Enables the command
     * @returns {Command} returns this to chain Functions
     */
    enable() {
      debug(DEBUG.INFO)(`Command "${this.getCommand()}" has been enabled`)
      this._enabled = true
      return this
    }

    /**
     * Enables the command
     * @returns {Boolean} returns true when the command is enabled
     */
    isEnabled() {
      return this._enabled
    }

    /**
     * Destroys and unloads a command completly
     * @returns {null}
     */
    destroy() {
      debug(DEBUG.INFO)(`Command "${this.getCommand()}" has been destroyed`)
      commands = commands.filter(cmd => cmd !== this)
      return null
    }

    /**
     * Retrieves the current command name
     * @returns {string} returns the command
     */
    getCommand() {
      return this._cmd
    }

    /**
     * Adds one or more alias to the command
     * @param {string} alias - one or more alias commands
     * @returns {Command} returns this to chain Functions
     */
    addAlias(...alias) {
      alias.forEach(cmd => {
        this._validateCommand(cmd)
        if (this._cmd === cmd) throw new Error("Alias is same as command already exists")
        if (this._alias.indexOf(cmd) >= 0) throw new Error("Alias already exists")
      })
      this._alias.push(...alias)
      return this
    }

    /**
     * Retrieves all alias commands
     * @returns {array} returns all available alias to the command
     */
    getAlias() {
      return this._alias
    }

    /**
     * Sets a short help text for the help command (used inside the !help command)
     * @param { string } text - the short help text
     * @returns {Command} returns this to chain Functions
     */
    help(text = "") {
      this._help = text
      return this
    }

    /**
     * Checks if the Command has a help text
     * @returns {boolean} returns true if the command has a help text
     */
    hasHelp() {
      return typeof this._help === "string" && this._help.length > 0
    }

    /**
     * Retrieves the SHort Help Command
     * @returns {string} returns the short help text
     */
    getHelp() {
      return this._help
    }

    /**
     * Sets a detailed manual command on how to use the command
     * the manual command can be called multiple times, for every call it will add it as a new line
     * @param {string} text - the manual text
     * @returns {Command} returns this to chain Functions
     */
    manual(text = "") {
      this._manual.push(text)
      return this
    }

    /**
     * Checks if the Command has a manual text
     * @returns {boolean} returns true if the command has a manual text
     */
    hasManual() {
      return this._manual.length > 0
    }

    /**
     * Retrieves the Manual text
     * @returns {string} returns the manual Command
     */
    getManual() {
      return this._manual.join("\r\n")
    }

    /**
     * Retrieves the usage of the command with its parameterized names
     * @returns {string} retrieves the complete usage of the command with its argument names
     */
    getUsage() {
      return `${getCommandPrefix()}${this.getCommand()} ${this.getArguments().map(arg => arg.getManual()).join(" ")}`
    }

    /**
     * Checks if the client has permissions to execute this command
     * takes a function as argument which will be called on every permission test
     * the function will receive the sinusbot client object as first parameter
     * the client should return a true value when the client is allowed to execute the command
     * @param {function} fnc - the function which gets executed
     * @returns {Command} returns this to chain Functions
     */
    checkPermission(fnc) {
      this._storeFunction("perms", fnc)
      return this
    }

    /**
     * Checks if a Client is allowed to use the command
     * @param {object} client - the sinusbot client object to check against
     * @returns {boolean} returns true if the client is allowed to use the command
     */
    isAllowed(client) {
      return Boolean(this._getFunction("perms")(client))
    }

    /**
     * Adds an argument to the command
     * @param {Argument} - the argument to add
     * @returns {Command} returns this to chain the command
     */
     addArgument(argument) {
       this._args.push(argument)
       return this
     }

     /**
      * Retrieves all available arguments
      * @param {Argument} - the argument to add
      * @returns {array} returns a list of defined Arguments
      */
      getArguments() {
        return this._args
      }

      /**
       * Sets the function which gets executed
       * @param {function} - the function which should be executed when the command has been validated successful
       * @returns {Command} returns this to chain Functions
       */
      exec(fnc) {
        this._storeFunction("exec", fnc)
        return this
      }

      /**
       * Dispatches the command
       * @private
       * @param {object} client - the caller which represents a TeamSpeak Client
       * @param {array} args - the args which have been resolved
       */
      dispatchCommand(...args) {
        return this._getFunction("exec")(...args)
      }

      /**
       * Sets the Command to ignore additional passed Arguments
       * @returns {Command} returns this to chain the command
       */
      ignoreTooManyArgs() {
        this._shouldIgnoreTooManyArgs = true
        return this
      }

      /**
       * Retrieves wether there should be an error if too many arguments has been passed
       * @returns {boolean}
       */
      shouldIgnoreTooManyArgs() {
        return this._shouldIgnoreTooManyArgs
      }
  }

  /**
   * Creates a new Command Instance with the given Command Name
   * @name createCommand
   * @param {string} cmd - the command which should be added
   * @returns {Command} returns this to chain Functions
   */
  function createCommand(cmd, OVERRIDES) {
    if (typeof cmd !== "string") throw new Error("Expected a string as command name!")
    if (cmd.length === 0) throw new Error("Command should have a minimum length of 2!")
    if (
      cmd.length === 1 && 
      OVERRIDES !== "YES_I_KNOW_THAT_I_SHOULD_NOT_USE_COMMANDS_WITH_LENGTH_OF_ONE"
    ) throw new Error("Command should have a minimum length of 2!")
    debug(DEBUG.INFO)(`registering command '${cmd}'`)
    if (getCommandByName(cmd)) {
      debug(DEBUG.WARNING)(`WARNING there is already a command with name '${cmd}' enabled!`)
      debug(DEBUG.WARNING)(`Command.js may work not as expected!`)
    }
    commands.push(new Command(cmd))
    return commands[commands.length - 1]
  }

  /**
   * Creates a new Argument Instance
   * @name createArgument
   * @param {string} type - the argument type which should be created
   * @returns {Argument} returns the created Argument
   */
  function createArgument(type) {
    if (typeof availableArguments[type.toLowerCase()] !== "function")
      throw new Error(`Argument type not found! Available Arguments: ${Object.keys(availableArguments).join(", ")}`)
    return availableArguments[type.toLowerCase()]()
  }

  /**
   * Creates a new Argument Instance
   * @name createGroupedArgument
   * @param {string} type - the argument type which should be created either "or" or "and" allowed
   * @returns {GroupArgument} returns this to chain Functions
   */
  function createGroupedArgument(type) {
    if (Object.values(GROUP_ARGS).indexOf(type) === -1) throw new Error(`Unexpected GroupArgument type, expected one of [${Object.values(GROUP_ARGS).join(", ")}] but got ${type}!`)
    return new GroupArgument(type)
  }
 
  /**
   * Creates a new Argument Instance
   * @name getCommandByName
   * @param {string} name - the name of the command which should be retrieved
   * @returns {Command|undefined} returns the command if found otherwise undefined
   */
  function getCommandByName(name) {
    return commands.filter(cmd => cmd.getCommand() === name)[0]
  }

  /**
   * retrieves the current Command Prefix
   * @name getCommandPrefix
   * @returns {string} returns the command prefix
   */
  function getCommandPrefix() {
    var prefix = engine.getCommandPrefix()
    if (typeof prefix !== "string" || prefix.length === 0) return "!"
    return prefix
  }

  /**
   * gets all available commands
   * @name getAvailableCommands
   * @param {Client} client - the sinusbot client for which the commands should be retrieved
   * @param {string|boolean} [cmd=false] - the command which should be searched for
   * @returns {Command[]} returns an array of commands
   */
  function getAvailableCommands(client, cmd = false) {
    return commands
      .filter(c => c.getCommand() === cmd || cmd === false)
      .filter(c => c.isEnabled())
      .filter(c => c.isAllowed(client))
  }

  /**
   * Creates a random string
   * @name randomString
   * @private
   * @param {number} [len=8] - the length of the string
   * @param {string} [chars=abcdefghijklmnopqrstuvwxyz0123456789] - the chars which get used
   * @returns {string} returns the random string with the given length
   */
  function randomString(len = 8, chars = "abcdefghijklmnopqrstuvwxyz0123456789") {
    return Array(len).fill().map(() => chars[Math.floor(Math.random() * chars.length)]).join("")
  }

  /**
   * Returns the correct reply chat from where the client has sent the message
   * @name getReplyOutput
   * @private
   * @param {number} mode - the mode from where the message came from [1=client, 2=channel, 3=server]
   * @param {Client} client - the sinusbot client which sent the message
   * @returns {function} returns a function where the chat message gets redirected to
   */
  function getReplyOutput(mode, client) {
    switch (mode) {
      case 1: return client.chat.bind(client)
      case 2: return client.getChannels()[0].chat.bind(client.getChannels()[0])
      case 3: return backend.chat.bind(backend)
      default: return msg => debug(DEBUG.WARNING)(`WARN no reply channel set for mode ${ev.mode}, message "${msg}" not sent!`)
    }
  }

  //creates the help command
  createCommand("help")
    .help("Displays this text")
    .manual(`Displays a list of useable commands`)
    .manual(`you can search/filter for a specific commands by adding a keyword`)
    .addArgument(createArgument("string").setName("filter").min(1).optional())
    .exec((client, {filter}, reply) => {
      var cmds = getAvailableCommands(client)
        .filter(cmd => cmd.hasHelp())
        .filter(cmd => {
          return !filter ||
            cmd.getCommand().match(new RegExp(filter, "i")) ||
            cmd.getAlias().some(alias => alias.match(new RegExp(filter, "i"))) ||
            cmd.getHelp().match(new RegExp(filter, "i"))
          })
      reply(`${format.bold(cmds.length)} Commands found:`)
      cmds.forEach(cmd => reply(`${format.bold(`${getCommandPrefix()}${cmd.getCommand()}`)} - ${cmd.getHelp()}`))
    })

  //creates the man command
  createCommand("man")
    .help("Displays detailed help about a command if available")
    .manual(`Displays detailed usage help for a specific command`)
    .addArgument(createArgument("string").setName("command").min(1))
    .exec((client, {command}, reply) => {
      var cmds = getAvailableCommands(client, command)
      if (cmds.length === 0) 
        return reply("No command with valid manual documentation found! Maybe did you misstype the command?")
      cmds.forEach(cmd => {
        var manual = "No manual for this command available!"
        if (cmd.hasManual()) {
          manual = cmd.getManual()
        } else if (cmd.hasHelp()) {
          manual = cmd.getHelp()
        }
        reply(`\nManual for command: ${format.bold(cmd.getCommand())}\n${format.bold("Usage:")} ${cmd.getUsage()}\n\n${manual}`)
      })
    })


  event.on("chat", ev => {
    //do not do anything when the bot sends a message
    if (ev.client.isSelf()) return
    //get the basic command with arguments and command splitted
    var match = ev.text.match(new RegExp("^"+engine.getCommandPrefix().split("").map(char => char.match(/[0-9\w]/) ? char : "\\"+char).join("")+"(?<command>\\w*) *(?<args>.*) *$", "i"))
    //return if no valid command has been found
    if (ev.text[0] !== engine.getCommandPrefix() && !match) return
    const { command } = match.groups
    //check if command exists
    var cmds = commands
      .filter(cmd => cmd.getCommand() === command || cmd.getAlias().indexOf(command) >= 0)
      .filter(cmd => cmd.isEnabled())
    if (cmds.length === 0) {
      //depending on the config setting return without error
      if (config.NOT_FOUND_MESSAGE !== "0") return
      //send the not found message
      return ev.client.chat(`There is no enabled command named "${format.bold(`${getCommandPrefix()}${command}`)}", check ${format.bold(`${getCommandPrefix()}help`)} to get a list of available commands!`)
    }
    //check if permissions are okay
    cmds = cmds.filter(cmd => {
      try {
        return cmd.isAllowed(ev.client)
      } catch(e) {
        debug(DEBUG.ERROR)("An error happened during permission handling")
        debug(DEBUG.ERROR)(e.stack)
        return false
      }
    })
    //send message because the client has no permissions to use this command
    if (cmds.length === 0) return ev.client.chat(`You have no Permissions to use the Command ${format.bold(command)}, check ${format.bold(`${getCommandPrefix()}help`)} to get a list of available commands!"`)
    //handle the arguments for all commands
    cmds
      .forEach(async cmd => {
        var { args } = match.groups
        var resolved = {}
        var error = null
        var possibleErrors = []
        var lastArg = null
        //validate each available command
        cmd.getArguments().some(arg => {
          lastArg = arg
          var result = arg.validate(args)
          if (result instanceof Error) { 
            if (!arg.isOptional()) return (error = result, true)
            resolved[arg.getName()] = arg.getDefault()
            possibleErrors.push([arg, result])
            return false
          }
          resolved[arg.getName()] = result[0]
          return (args = result[1].trim(), false)
        })
        //check if too many arguments have been parsed and no error occured
        if ((!cmd.shouldIgnoreTooManyArgs() || possibleErrors.length > 0) && args.length > 0 && !(error instanceof Error)) {
          debug(DEBUG.VERBOSE)(`Argument parsing failed for cmd ${cmd.getCommand()}`)
          debug(DEBUG.VERBOSE)(`Should ignore to many args? ${cmd.shouldIgnoreTooManyArgs()}`)
          debug(DEBUG.VERBOSE)(`How many possible Errors? ${possibleErrors.length}`)
          debug(DEBUG.VERBOSE)(`Total Arguments given? ${args.length }`)
          if (possibleErrors.length > 0) {
            var [arg, err] = possibleErrors[0]
            ev.client.chat(`Possible Error during parsing Argument ${arg.getManual()}: ${format.bold(err.message)}`)
          } else {
            ev.client.chat("Too many Arguments passed!")
          }
        } else {
          if (error === null) {
            //start the command execution
            var start = Date.now()
            try {
              await Promise.resolve(cmd.dispatchCommand(ev.client, resolved, getReplyOutput(ev.mode, ev.client), ev))
              debug(DEBUG.VERBOSE)(`Command "${cmd.getCommand()}" finnished successfully after ${Date.now()-start}ms`)
            } catch (e) {
              //caught an error during processing
              debug(DEBUG.VERBOSE)(`Command "${cmd.getCommand()}" failed after ${Date.now()-start}ms`)
              debug(DEBUG.ERROR)(`Error while handling command "${cmd.getCommand()}"!`)
              debug(DEBUG.ERROR)(`This is probably a problem with a Script which is using Command.js!`)
              debug(DEBUG.ERROR)(e.stack)
              ev.client.chat("An error happened while processing the command :(")
            }
            return
          }
          //handle an error
          ev.client.chat(`Argument parsed with an error ${format.bold(lastArg.getManual())}`)
          ev.client.chat(`Returned with ${format.bold(error.message)}`)
        }
        ev.client.chat(`Invalid Command usage! For Command usage see ${format.bold(`${getCommandPrefix()}man ${cmd.getCommand()}`)}`)
      })
  })



  engine.export({
    createCommand,
    createArgument,
    createGroupedArgument,
    getCommandPrefix,
    getAvailableCommands,
    getCommandByName
  })

})
