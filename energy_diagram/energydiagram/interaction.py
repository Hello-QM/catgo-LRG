import time

class LabelEditorMixin:
    """提供标签编辑和拖拽功能的混入类"""
    def init_label_editing(self):
        """初始化独立的状态跟踪器"""
        self._is_dragging = False  # 拖拽状态
        self._is_editing = False   # 编辑状态
        self._active_label = None  # 当前操作对象
        self._current_label = None
        self._offset = (0, 0)
        self._textbox = None
        self.key_step = 0.02
        
    def _connect_editor_events(self):
        """连接所有编辑器事件"""
        self._cid_press = self.fig.canvas.mpl_connect('button_press_event', self._on_editor_action)
        self._cid_motion = self.fig.canvas.mpl_connect('motion_notify_event', self._on_mouse_move)
        self._cid_release = self.fig.canvas.mpl_connect('button_release_event', self._on_mouse_release)

    def _on_editor_action(self, event):
        """分离左右键事件处理"""
        # 右键单击处理
        if event.button == 3:  # 右键
            self._handle_right_click(event)
            return
            
        # 左键处理（保持原有拖拽逻辑）
        if event.button == 1:  
            if event.inaxes != self.ax or self._is_editing:
                return

            # 原有左键拖拽检测逻辑
            x, y = event.xdata, event.ydata
            self._active_label = None
            
            for text in reversed(self.text_labels):
                try:
                    bbox = text.get_window_extent()
                    if bbox.contains(event.x, event.y):
                        self._active_label = text
                        self._drag_start = (x, y)
                        self._is_dragging = True
                        print(f"开始拖拽标签：{text.get_text()}")
                        break
                except Exception as e:
                    print(f"标签检测错误：{str(e)}")

    def _handle_right_click(self, event):
        """处理右键单击逻辑"""
        print(">> 右键单击事件")
        if event.inaxes != self.ax or self._is_editing:
            return

        # 保存坐标
        self._right_click_coords = (event.xdata, event.ydata) if event.inaxes else None
        
        # 立即处理右键点击
        try:
            display_coords = self.ax.transData.transform([(event.xdata, event.ydata)])[0]
            x_pixel, y_pixel = display_coords
            self._process_right_click(x_pixel, y_pixel)
        except Exception as e:
            print(f"坐标转换错误：{str(e)}")

    def _process_right_click(self, x_pixel, y_pixel):
        """处理右键点击核心逻辑"""
        label_found = False
        for text in reversed(self.text_labels):
            try:
                bbox = text.get_window_extent()
                if bbox.contains(x_pixel, y_pixel):
                    self._start_editing(text, None)
                    label_found = True
                    break
            except Exception as e:
                print(f"标签检测错误：{str(e)}")
        
        if not label_found and self._right_click_coords:
            print("右键创建新标签")
            self._create_new_label(None)

    def _on_mouse_move(self, event):
        """处理鼠标移动事件"""
        if self._is_dragging and event.inaxes:
            new_x = event.xdata + self._offset[0]
            new_y = event.ydata + self._offset[1]
            self._active_label.set_position((new_x, new_y))
            self.fig.canvas.draw_idle()

    def _on_mouse_release(self, event):
        """原子化状态重置"""
        if self._is_dragging:
            # 先重置状态再执行其他操作
            was_dragging = self._is_dragging
            self._is_dragging = False  # 立即重置
            
            print(f"🛑 结束拖拽（原状态：{was_dragging}）→ 新状态：{self._is_dragging}")
            
            # 后续清理操作
            if self._active_label and not self._is_editing:
                self._active_label.set_bbox(None)
                self._active_label = None
                
            self.fig.canvas.draw_idle()

    # 添加状态追踪装饰器（调试用）
    def _log_state_change(func):
        def wrapper(self, *args, **kwargs):
            print(f"进入 {func.__name__}，当前状态：e={self._is_editing}, d={self._is_dragging}")
            result = func(self, *args, **kwargs)
            print(f"离开 {func.__name__}，新状态：e={self._is_editing}, d={self._is_dragging}")
            return result
        return wrapper

    # 给关键方法添加装饰器
    @_log_state_change
    def _start_editing(self, text, event):
        """强化状态互斥锁"""
        if self._is_editing or self._is_dragging:
            print(f"🚫 操作冲突：editing={self._is_editing}, dragging={self._is_dragging}")
            return
            
        print(f"🔏 进入独占编辑模式，标签：{text.get_text()}")
        self._is_editing = True
        self._active_label = text
        # 强制解除其他状态
        self._is_dragging = False
        
        # 创建临时文本框
        try:
            self._textbox = self.ax.text(
                *text.get_position(),
                text.get_text(),
                fontsize=text.get_fontsize(),
                ha='center',
                va='bottom',
                bbox=dict(facecolor='white', edgecolor='blue')
            )
            text.set_visible(False)
            self.fig.canvas.draw_idle()
            
            # 连接键盘事件
            self._cid_key = self.fig.canvas.mpl_connect(
                'key_press_event', self._on_text_input)
            print(f"编辑初始化完成，textbox={self._textbox is not None}")
            
        except Exception as e:
            print(f"启动编辑失败：{str(e)}")
            self._is_editing = False
            self._active_label = None

    def _on_text_input(self, event):
        """编辑结束处理（严格状态验证）"""
        if not self._is_editing:
            return
            
        if event.key == 'enter':
            print("尝试提交编辑...")
            # 保存前添加有效性检查
            if not (self._active_label and self._textbox):
                print("错误：无效的编辑状态")
                return
            
            try:
                # 更新原始标签
                self._active_label.set_text(self._textbox.get_text())
                self._active_label.set_visible(True)
                print(f"已更新标签内容：{self._textbox.get_text()}")
                
                # 先断开事件监听
                if hasattr(self, '_cid_key'):
                    self.fig.canvas.mpl_disconnect(self._cid_key)
                    print("已断开文本输入事件")
                    
                # 再移除临时文本框
                if self._textbox:
                    self._textbox.remove()
                    print("已移除临时文本框")
                    
                # 最后重置状态
                self._is_editing = False
                self._active_label = None
                self._textbox = None
                print("状态已重置")
                
                # 强制重绘
                self.fig.canvas.draw_idle()
                
            except Exception as e:
                print(f"保存时发生错误：{str(e)}")
                # 异常时强制重置
                self._is_editing = False
                self._active_label = None
                self._textbox = None
                
        elif event.key == 'backspace':
            self._textbox.set_text(self._textbox.get_text()[:-1])
        elif event.key == 'shift':  # 忽略修饰键
            pass
        elif len(event.key) == 1:
            self._textbox.set_text(self._textbox.get_text() + event.key)
        
        self.fig.canvas.draw_idle()

    def _create_new_label(self, event):
        """更新创建逻辑使用右键坐标"""
        if hasattr(self, '_right_click_coords') and self._right_click_coords:
            x, y = self._right_click_coords
            new_label = self.ax.text(
                x,
                y,
                "New Label",
                fontsize=self.config.font_size_text,
                ha='center',
                va='bottom',
                picker=True,  # 必须保留
                gid=f"custom_{len(self.text_labels)}",
                zorder=5  # 确保在顶层
            )
            self.text_labels.append(new_label)
            self.fig.canvas.draw_idle()
            self._right_click_coords = None  # 清除坐标缓存