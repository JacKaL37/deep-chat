import {MessageStream} from '../views/chat/messages/stream/messageStream';
import {AppConfig, ChatOptions} from '../types/webModel/webLLM/webLLM';
import {MessageUtils} from '../views/chat/messages/messageUtils';
import {IntroMessage, MessageContent} from '../types/messages';
import {BaseServiceIO} from '../services/utils/baseServiceIO';
import {WebModelIntroMessage} from './webModelIntroMessage';
import {ElementUtils} from '../utils/element/elementUtils';
import * as WebLLM from '../types/webModel/webLLM/webLLM';
import {WebModelConfig} from '../types/webModel/webModel';
import {MessageContentI} from '../types/messagesInternal';
import {Messages} from '../views/chat/messages/messages';
// import * as WebLLM2 from 'deep-chat-web-llm';
import config from './webModelConfig';
import {DeepChat} from '../deepChat';

declare global {
  interface Window {
    webLLM: typeof WebLLM;
  }
}

// WORK - in playground - upon the component that uses web model - remove static
export class WebModel extends BaseServiceIO {
  private static chat?: WebLLM.ChatInterface;
  // WORK - if caching error - add a button to clear the cache on error
  private static readonly GENERIC_ERROR =
    'Error, please check the following list of [instructions](https://deepchat.dev/docs/webModel#error) to fix this.';
  private static readonly MULTIPLE_MODELS_ERROR = 'Cannot run multiple web models';
  private static readonly WEB_LLM_NOT_FOUND_ERROR = 'WebLLM module not found';
  private static readonly DEFAULT_MODEL = 'Llama-2-7b-chat-hf-q4f32_1';
  public static readonly MODULE_SEARCH_LIMIT_S = 5;
  private _isModelLoaded = false;
  private _isModelLoading = false;
  private _loadOnFirstMessage = false;
  private readonly _webModel: WebModelConfig = {};
  permittedErrorPrefixes = [WebModel.MULTIPLE_MODELS_ERROR, WebModel.WEB_LLM_NOT_FOUND_ERROR, WebModel.GENERIC_ERROR];
  private readonly _conversationHistory: Array<[string, string]> = [];
  private readonly _chatEl?: HTMLElement;
  private _removeIntro?: () => void;
  private _messages?: Messages;

  constructor(deepChat: DeepChat) {
    super(deepChat);
    // window.webLLM = WebLLM2 as unknown as typeof WebLLM;
    if (typeof deepChat.webModel === 'object') this._webModel = deepChat.webModel;
    if (this._webModel.load?.clearCache) WebModel.clearAllCache();
    this.findModelInWindow(deepChat);
    this.canSendMessage = this.canSubmit.bind(this);
    this._chatEl = deepChat.shadowRoot?.children[0] as HTMLElement;
    if (deepChat.initialMessages) WebModel.setUpHistory(this._conversationHistory, deepChat.initialMessages);
  }

  // need ref of messages object as web model exhibits unique behaviour to manipulate chat
  public setUpMessages(messages: Messages) {
    this._messages = messages;
    this._removeIntro = () => {
      messages.removeIntroductoryMessage();
      this._removeIntro = undefined;
    };
  }

  private static setUpHistory(conversationHistory: Array<[string, string]>, initialMessages: MessageContent[]) {
    initialMessages.forEach((message, index) => {
      if (message.role === MessageUtils.USER_ROLE && message.text) {
        const nextMessage = initialMessages[index + 1];
        if (nextMessage?.text && nextMessage.role !== MessageUtils.USER_ROLE) {
          conversationHistory.push([message.text, nextMessage.text]); // [userText, aiText]
        }
      }
    });
  }

  private findModelInWindow(deepChat: DeepChat, seconds = 0) {
    if (window.webLLM) {
      this.configureInit(this.shouldAddInitialMessage(deepChat.introMessage));
    } else if (seconds > WebModel.MODULE_SEARCH_LIMIT_S) {
      this._messages?.addNewErrorMessage('service', WebModel.WEB_LLM_NOT_FOUND_ERROR);
      console.error(
        'The WebLLM module is either not in the project or not been attached to the window object. ' +
          'Please see the following guide:'
      );
      // WORK
      console.error('Hello World');
    } else {
      setTimeout(() => this.findModelInWindow(deepChat, seconds + 1), 1000);
    }
  }

  private shouldAddInitialMessage(customIntroMessage?: IntroMessage) {
    return !customIntroMessage && this._webModel && this._webModel.introMessage?.displayed !== false;
  }

  private scrollToTop(timeoutMS?: number) {
    if (this._webModel.introMessage?.autoScroll === false) return;
    setTimeout(() => {
      if (this._messages?.elementRef) ElementUtils.scrollToTop(this._messages?.elementRef);
    }, timeoutMS);
  }

  public getIntroMessage(customIntroMessage?: IntroMessage) {
    if (!this.shouldAddInitialMessage(customIntroMessage) || !this._chatEl) return;
    const html = WebModelIntroMessage.setUpInitial(this.init.bind(this), this._webModel.introMessage, this._chatEl);
    this.scrollToTop(1);
    return {role: MessageUtils.AI_ROLE, html, sendUpdate: false};
  }

  private async configureInit(wasIntroSet: boolean) {
    const {load} = this._webModel;
    if (load) {
      if (load.onInit) {
        this.init();
        return;
      }
      if (load.onMessage) {
        this._loadOnFirstMessage = true;
        return;
      }
    }
    if (!wasIntroSet) this.init();
  }

  private async init(files?: FileList) {
    const chat = this.attemptToCreateChat();
    if (chat) await this.loadModel(chat, files);
  }

  private attemptToCreateChat() {
    if (WebModel.chat) {
      this._messages?.addNewErrorMessage('service', WebModel.MULTIPLE_MODELS_ERROR);
      console.error(WebModel.MULTIPLE_MODELS_ERROR);
      return;
    }
    if (this._isModelLoaded || this._isModelLoading) return;
    const {worker} = this._webModel;
    return config.use_web_worker && worker ? new window.webLLM.ChatWorkerClient(worker) : new window.webLLM.ChatModule();
  }

  private getConfig() {
    let model = WebModel.DEFAULT_MODEL;
    if (this._webModel.model) model = this._webModel.model;
    const appConfig = JSON.parse(JSON.stringify(config)) as AppConfig;
    if (this._webModel.urls?.model) {
      const modelConfig = appConfig.model_list.find((modelConfig) => (modelConfig.local_id = model));
      if (modelConfig) modelConfig.model_url = this._webModel.urls.model;
    }
    if (this._webModel.urls?.wasm) {
      const modelKey = model as keyof typeof appConfig.model_lib_map;
      const wasm = appConfig.model_lib_map[modelKey];
      if (wasm) appConfig.model_lib_map[modelKey] = this._webModel.urls.wasm;
    }
    if (this._webModel.load?.skipCache) appConfig.use_cache = false;
    return {model, appConfig};
  }

  private async loadModel(chat: WebLLM.ChatInterface, files?: FileList) {
    this.scrollToTop();
    WebModel.chat = chat;
    // await window.webLLM.hasModelInCache(this.selectedModel, config); can potentially reuse this in the future
    this._isModelLoading = true;
    let isNewMessage = this._webModel.introMessage?.displayed === false;
    const initProgressCallback = (report: WebLLM.InitProgressReport) => {
      this._messages?.addNewMessage({html: `<div>${report.text}</div>`, overwrite: true, sendUpdate: false});
      if (isNewMessage) {
        setTimeout(() => ElementUtils.scrollToBottom(this._messages?.elementRef as HTMLElement));
        isNewMessage = false;
      }
    };
    WebModel.chat.setInitProgressCallback(initProgressCallback);
    let loadedFiles: File[];
    try {
      const {model, appConfig} = this.getConfig();
      const chatOpts: ChatOptions = {conv_config: {system: 'keep responses to one sentence'}};
      if (this._conversationHistory.length > 0) chatOpts.conversation_history = this._conversationHistory;
      loadedFiles = (await WebModel.chat.reload(model, chatOpts, appConfig, files)) as File[];
    } catch (err) {
      return this.unloadChat(err as string);
    }
    if (!this._webModel.introMessage?.removeAfterLoad) {
      const html = WebModelIntroMessage.setUpAfterLoad(loadedFiles, this._webModel.introMessage, this._chatEl);
      this._messages?.addNewMessage({html, overwrite: true, sendUpdate: false});
    } else if (this._webModel.introMessage.displayed === false) {
      this._messages?.removeLastMessage();
    } else {
      this._removeIntro?.();
    }
    this._isModelLoaded = true;
    this._isModelLoading = false;
  }

  private async generateResp(messages: Messages, pMessages: MessageContentI[], chat: WebLLM.ChatInterface) {
    const text = pMessages[pMessages.length - 1].text as string;
    try {
      if (this.deepChat.stream) {
        this.streamResp(messages, text, chat);
      } else {
        this.immediateResp(messages, text, chat);
      }
    } catch (err) {
      this.unloadChat(err as string);
    }
  }

  private async immediateResp(messages: Messages, text: string, chat: WebLLM.ChatInterface) {
    const output = await chat.generate(text, undefined, 0); // anything but 1 will not stream
    messages.addNewMessage({text: output});
    this.completionsHandlers.onFinish();
  }

  private async streamResp(messages: Messages, text: string, chat: WebLLM.ChatInterface) {
    this.streamHandlers.abortStream.abort = () => {
      chat.interruptGenerate();
    };
    this.streamHandlers.onOpen();
    const stream = new MessageStream(messages);
    await chat.generate(text, (_: number, message: string) => {
      stream.upsertStreamedMessage({text: message, overwrite: true});
    });
    stream.finaliseStreamedMessage();
    this.streamHandlers.onClose();
  }

  private canSubmit(text?: string) {
    if (!text?.trim() || this._isModelLoading) return false;
    if (this._loadOnFirstMessage) return true;
    return !!this._isModelLoaded;
  }

  override async callServiceAPI(messages: Messages, pMessages: MessageContentI[]) {
    if (!this._isModelLoaded) {
      if (this._loadOnFirstMessage) {
        await this.init();
      } else {
        return;
      }
    }
    if (!WebModel.chat || this._isModelLoading) return;
    if (this._webModel.introMessage?.removeAfterMessage) this._removeIntro?.();
    messages.addLoadingMessage();
    this.generateResp(messages, pMessages, WebModel.chat);
  }

  private async unloadChat(err: string) {
    this._messages?.addNewErrorMessage('service', WebModel.GENERIC_ERROR);
    console.error(err);
    this._isModelLoaded = false;
    this._isModelLoading = false;
    if (!WebModel.chat) return;
    await WebModel.chat.unload();
    WebModel.chat = undefined;
  }

  override isWebModel() {
    return true;
  }

  private static clearAllCache() {
    // IMPORTANT - 'webllm/model' and 'webllm/wasm' need to match the scope in 'deep-chat-web-llm':
    // chat_module file's fetchNDArrayCache call's scope:
    // const resultFiles = await tvm.fetchNDArrayCache(modelUrl, tvm.webgpu(), "webllm/model"...
    // and chat_module file's: const wasmCache = new tvmjs.ArtifactCache("webllm/wasm");
    WebModel.clearCache('webllm/model');
    WebModel.clearCache('webllm/wasm');
  }

  private static clearCache(scope: string) {
    caches.open(scope).then((cache) => {
      cache.keys().then((keys) => {
        keys.forEach((key) => {
          cache.delete(key);
        });
      });
    });
  }
}
