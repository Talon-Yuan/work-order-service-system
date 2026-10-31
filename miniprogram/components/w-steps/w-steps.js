// components/w-steps/w-steps.js
Component({
  properties: {
    text: { type: String, value: '' },
    visible: { type: Boolean, value: false }
  },
  data: {},
  methods: {
    show(msg) {
      this.setData({ text: msg || this.data.text, visible: true });
      setTimeout(() => this.setData({ visible: false }), 2200);
    },
    close() { this.setData({ visible: false }); }
  }
});
